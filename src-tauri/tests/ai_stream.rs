//! End-to-end tests for the AI transport against a real local HTTP server.
//!
//! These do not touch DeepSeek: a tiny hand-rolled server speaks the same
//! OpenAI-compatible SSE dialect, so the parsing, streaming, error and timeout
//! paths are exercised deterministically.

use shutter_lib::ai::{endpoint, AiClient, SseBuffer};
use shutter_lib::types::AiAction;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;

/// Serve exactly one request on an ephemeral port, then exit.
fn serve_once(status: &'static str, body: String) -> (String, Arc<Mutex<Vec<u8>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_clone = Arc::clone(&seen);

    thread::spawn(move || {
        let (mut socket, _) = match listener.accept() {
            Ok(pair) => pair,
            Err(_) => return,
        };
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        // Read until the headers and the declared body length have arrived.
        loop {
            let n = match socket.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            buf.extend_from_slice(&chunk[..n]);
            if let Some(header_end) = find_header_end(&buf) {
                let head = String::from_utf8_lossy(&buf[..header_end]).to_lowercase();
                let len = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if buf.len() >= header_end + 4 + len {
                    break;
                }
            }
        }
        *seen_clone.lock().unwrap() = buf;

        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/event-stream\r\n\
             Cache-Control: no-cache\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = socket.write_all(response.as_bytes());
        let _ = socket.flush();
    });

    (format!("http://127.0.0.1:{port}"), seen)
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn sse(chunks: &[&str]) -> String {
    let mut out = String::new();
    for c in chunks {
        out.push_str(&format!(
            "data: {{\"choices\":[{{\"delta\":{{\"content\":{}}}}}]}}\n\n",
            serde_json::to_string(c).unwrap()
        ));
    }
    out.push_str("data: [DONE]\n\n");
    out
}

#[test]
fn endpoint_appends_chat_completions() {
    assert_eq!(
        endpoint("http://127.0.0.1:1234"),
        "http://127.0.0.1:1234/chat/completions"
    );
}

#[tokio::test]
async fn streams_deltas_in_order() {
    let (base, seen) = serve_once("200 OK", sse(&["你好", "，世界", "！"]));

    let client = AiClient::new().unwrap();
    let mut got = Vec::new();
    client
        .stream_with(
            &base,
            "test-model",
            "sk-test",
            AiAction::Explain,
            None,
            None,
            b"\x89PNG\r\n\x1a\nfake",
            |text| got.push(text),
        )
        .await
        .expect("stream should succeed");

    assert_eq!(got, vec!["你好", "，世界", "！"]);

    let request = String::from_utf8_lossy(&seen.lock().unwrap()).to_string();
    assert!(request.contains("POST /chat/completions"), "got: {request}");
    // Header names are case-insensitive, and the casing on the wire depends on
    // who writes them: reqwest emits lowercase, an HTTP proxy rewrites them to
    // canonical form. Compare on a lowercased copy instead of enumerating both.
    assert!(
        request.to_lowercase().contains("authorization: bearer sk-test"),
        "got: {request}"
    );
    assert!(request.contains("\"model\":\"test-model\""));
    assert!(request.contains("data:image/png;base64,"), "image must be inlined");
    assert!(request.contains("\"stream\":true"));
}

#[tokio::test]
async fn http_error_is_reported_with_upstream_message() {
    let body = r#"{"error":{"message":"invalid api key"}}"#.to_string();
    let (base, _seen) = serve_once("401 Unauthorized", body);

    let client = AiClient::new().unwrap();
    let err = client
        .stream_with(
            &base,
            "m",
            "bad-key",
            AiAction::Extract,
            None,
            None,
            b"x",
            |_| {},
        )
        .await
        .expect_err("must fail");

    let text = format!("{err:#}");
    assert!(text.contains("401"), "got: {text}");
    assert!(text.contains("invalid api key"), "got: {text}");
}

#[tokio::test]
async fn empty_stream_is_an_error() {
    // Valid SSE framing, but no content deltas at all.
    let (base, _seen) = serve_once("200 OK", "data: [DONE]\n\n".to_string());

    let client = AiClient::new().unwrap();
    let err = client
        .stream_with(&base, "m", "k", AiAction::Explain, None, None, b"x", |_| {})
        .await
        .expect_err("empty answer must not look like success");
    assert!(format!("{err:#}").contains("没有返回任何内容"));
}

#[tokio::test]
async fn upstream_error_event_mid_stream_aborts() {
    let body = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"部分\"}}]}\n\n",
        "data: {\"error\":{\"message\":\"quota exceeded\"}}\n\n"
    )
    .to_string();
    let (base, _seen) = serve_once("200 OK", body);

    let client = AiClient::new().unwrap();
    let mut got = Vec::new();
    let err = client
        .stream_with(&base, "m", "k", AiAction::Explain, None, None, b"x", |t| got.push(t))
        .await
        .expect_err("mid-stream error must abort");

    assert_eq!(got, vec!["部分"], "text received before the error is kept");
    assert!(format!("{err:#}").contains("quota exceeded"));
}

#[tokio::test]
async fn translate_sends_target_language() {
    let (base, seen) = serve_once("200 OK", sse(&["Hello"]));
    let client = AiClient::new().unwrap();
    client
        .stream_with(
            &base,
            "m",
            "k",
            AiAction::Translate,
            Some("English"),
            None,
            b"x",
            |_| {},
        )
        .await
        .unwrap();

    let request = String::from_utf8_lossy(&seen.lock().unwrap()).to_string();
    assert!(request.contains("English"), "prompt should name the language");
}

#[test]
fn sse_buffer_is_chunk_boundary_safe() {
    let mut buf = SseBuffer::default();
    // Split a single event across three reads.
    assert!(buf.push("da").is_empty());
    assert!(buf.push("ta: {\"a\":1}").is_empty());
    assert_eq!(buf.push("\n\n"), vec!["{\"a\":1}".to_string()]);
}

// ---------------------------------------------------------------------------
// Live check against the real provider. Ignored by default because it spends
// quota and needs a stored key:
//
//   cargo test --test ai_stream -- --ignored --nocapture live_deepseek
//
// It sends a synthetic image only — never the user's screen.
// ---------------------------------------------------------------------------

/// Build a small PNG with a solid colour, so the answer is verifiable.
fn synthetic_png(rgba: [u8; 4], size: u32) -> Vec<u8> {
    let img = image::RgbaImage::from_pixel(size, size, image::Rgba(rgba));
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png).unwrap();
    buf.into_inner()
}

#[tokio::test]
#[ignore]
async fn live_deepseek_vision_round_trip() {
    let settings = shutter_lib::settings::load_settings();
    let key = match shutter_lib::settings::load_api_key() {
        Ok(k) => k,
        Err(e) => {
            println!("SKIP: no stored API key ({e})");
            return;
        }
    };
    println!("using base_url={} model={}", settings.base_url, settings.model);

    // Pure red square: the model only needs to name the colour.
    let png = synthetic_png([220, 20, 20, 255], 256);
    let client = AiClient::new().unwrap();
    let mut answer = String::new();

    let result = client
        .stream_with(
            &settings.base_url,
            &settings.model,
            &key,
            AiAction::Ask,
            None,
            Some("这张图是什么颜色？只回答颜色名称。"),
            &png,
            |t| answer.push_str(&t),
        )
        .await;

    match result {
        Ok(()) => {
            println!("ANSWER: {answer}");
            let lower = answer.to_lowercase();
            assert!(
                lower.contains("红") || lower.contains("red"),
                "expected the model to name red, got: {answer}"
            );
        }
        Err(e) => panic!("live request failed: {e:#}"),
    }
}
