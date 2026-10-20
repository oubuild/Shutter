//! Connection-probe tests against a local mock provider.
//!
//! The probe is judged by what it puts on the wire (request line, bearer header,
//! fallback body), so a hand-rolled HTTP/1.1 server on an ephemeral port is the
//! only honest way to test it: no network, no quota, exact status codes.

use shutter_lib::ai::{models_endpoint, parse_models, ProbeClient};
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

struct MockServer {
    base: String,
    state: Arc<MockState>,
    handle: Option<thread::JoinHandle<()>>,
}

struct MockState {
    /// One response per connection, served in order.
    responses: Vec<(u16, &'static str)>,
    requests: Mutex<Vec<String>>,
    accepted: AtomicUsize,
    stop: AtomicBool,
}

impl MockServer {
    fn start(responses: Vec<(u16, &'static str)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let port = listener.local_addr().unwrap().port();
        // Non-blocking accept lets the thread notice `stop` without a timeout hack.
        listener.set_nonblocking(true).expect("non-blocking listener");
        let state = Arc::new(MockState {
            responses,
            requests: Mutex::new(Vec::new()),
            accepted: AtomicUsize::new(0),
            stop: AtomicBool::new(false),
        });
        let shared = Arc::clone(&state);
        let handle = thread::spawn(move || serve(&listener, &shared));
        Self {
            base: format!("http://127.0.0.1:{port}"),
            state,
            handle: Some(handle),
        }
    }

    /// Stop the server, returning every request it read and how many connections
    /// it saw. Extra connections are counted so "must not fall back" is provable.
    fn finish(mut self) -> (Vec<String>, usize) {
        self.state.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            handle.join().expect("mock server thread");
        }
        let requests = std::mem::take(&mut *self.state.requests.lock().unwrap());
        (requests, self.state.accepted.load(Ordering::SeqCst))
    }
}

fn serve(listener: &TcpListener, state: &MockState) {
    let mut served = 0usize;
    loop {
        if state.stop.load(Ordering::SeqCst) {
            // The call under test has already returned, so any connection still
            // queued in the backlog was made before that point: drain and count it.
            while let Ok((mut socket, _)) = listener.accept() {
                state.accepted.fetch_add(1, Ordering::SeqCst);
                write_response(&mut socket, 500, "unexpected extra connection");
            }
            return;
        }
        match listener.accept() {
            Ok((mut socket, _)) => {
                state.accepted.fetch_add(1, Ordering::SeqCst);
                // macOS makes an accepted socket inherit O_NONBLOCK from the
                // listener, which would make the first read return WouldBlock.
                let _ = socket.set_nonblocking(false);
                let request = read_request(&mut socket);
                let (status, body) = state
                    .responses
                    .get(served)
                    .copied()
                    .unwrap_or((500, "unexpected extra connection"));
                served += 1;
                state.requests.lock().unwrap().push(request);
                write_response(&mut socket, status, body);
            }
            Err(ref e) if e.kind() == ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(2));
            }
            Err(_) => return,
        }
    }
}

fn read_request(socket: &mut TcpStream) -> String {
    // Never let a malformed request wedge the suite.
    let _ = socket.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
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
    String::from_utf8_lossy(&buf).to_string()
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Internal Server Error",
    }
}

fn write_response(socket: &mut TcpStream, status: u16, body: &str) {
    let response = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        reason(status),
        body.len()
    );
    let _ = socket.write_all(response.as_bytes());
    let _ = socket.flush();
}

/// Build the client under test.
///
/// No `NO_PROXY` is set on purpose: `ProbeClient` routes loopback through a
/// proxy-free transport itself (see `ai::is_loopback`), and these tests are what
/// proves it. A machine with a system proxy configured is the interesting case —
/// without that routing, every mock here would be reached through the proxy,
/// with absolute-URI request lines and a 502 for a closed port.
fn probe_client() -> ProbeClient {
    ProbeClient::new().expect("build probe client")
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

#[test]
fn parse_models_sorts_and_dedupes_ids() {
    let body = r#"{"object":"list","data":[
        {"id":"model-b"},{"id":"model-a"},{"id":" model-a "},{"id":"model-c"}
    ]}"#;
    assert_eq!(parse_models(body), vec!["model-a", "model-b", "model-c"]);
}

#[test]
fn parse_models_returns_empty_for_unexpected_shapes() {
    // A provider with a different schema must not break the settings page; the
    // user can still type a model name by hand.
    for body in [
        "not json",
        "{}",
        r#"{"data":{}}"#,
        r#"{"data":[{"name":"x"},{"id":7},{"id":""}]}"#,
    ] {
        assert!(parse_models(body).is_empty(), "body: {body}");
    }
}

#[test]
fn models_endpoint_joins_the_listing_path() {
    assert_eq!(
        models_endpoint("https://api.deepseek.com"),
        "https://api.deepseek.com/models"
    );
    assert_eq!(
        models_endpoint("https://api.deepseek.com/"),
        "https://api.deepseek.com/models"
    );
    assert_eq!(
        models_endpoint("https://proxy.test/v1"),
        "https://proxy.test/v1/models"
    );
    // A base copied from the chat endpoint still resolves to the listing route.
    assert_eq!(
        models_endpoint("https://proxy.test/v1/chat/completions"),
        "https://proxy.test/v1/models"
    );
    assert_eq!(
        models_endpoint("  https://proxy.test/chat/completions  "),
        "https://proxy.test/models"
    );
}

// ---------------------------------------------------------------------------
// list_models
// ---------------------------------------------------------------------------

#[tokio::test]
async fn list_models_gets_the_listing_path_and_sends_the_key() {
    let bare = MockServer::start(vec![(
        200,
        r#"{"data":[{"id":"model-a"},{"id":"model-b"}]}"#,
    )]);
    let client = probe_client();
    let ids = client.list_models(&bare.base, "sk-test").await.expect("list");
    assert_eq!(ids, vec!["model-a", "model-b"]);

    let (requests, accepted) = bare.finish();
    assert_eq!(accepted, 1);
    assert!(
        requests[0].starts_with("GET /models HTTP/1.1"),
        "got: {}",
        requests[0]
    );
    assert!(
        requests[0]
            .to_lowercase()
            .contains("authorization: bearer sk-test"),
        "got: {}",
        requests[0]
    );

    // A base that already names /v1 must keep it: the route lives next to it.
    let v1 = MockServer::start(vec![(200, r#"{"data":[{"id":"model-v1"}]}"#)]);
    let ids = client
        .list_models(&format!("{}/v1", v1.base), "sk-test")
        .await
        .expect("list");
    assert_eq!(ids, vec!["model-v1"]);

    let (requests, accepted) = v1.finish();
    assert_eq!(accepted, 1);
    assert!(
        requests[0].starts_with("GET /v1/models HTTP/1.1"),
        "got: {}",
        requests[0]
    );
}

#[tokio::test]
async fn list_models_surfaces_the_upstream_error() {
    let mock = MockServer::start(vec![(401, r#"{"error":{"message":"invalid api key"}}"#)]);
    let client = probe_client();
    let err = client
        .list_models(&mock.base, "bad-key")
        .await
        .expect_err("401 must fail");

    let text = format!("{err:#}");
    assert!(text.contains("401"), "got: {text}");
    assert!(text.contains("invalid api key"), "got: {text}");

    let (_, accepted) = mock.finish();
    assert_eq!(accepted, 1);
}

// ---------------------------------------------------------------------------
// test_connection
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_connection_succeeds_via_the_models_route() {
    let mock = MockServer::start(vec![(
        200,
        r#"{"data":[{"id":"model-b"},{"id":"model-a"},{"id":"model-a"}]}"#,
    )]);
    let client = probe_client();
    let report = client
        .test_connection(&mock.base, "model-a", "sk-test")
        .await;

    assert!(report.ok, "detail: {}", report.detail);
    assert_eq!(report.via, Some("models"));
    assert_eq!(report.models, vec!["model-a", "model-b"]);
    assert!(report.latency_ms.is_some());

    let (requests, accepted) = mock.finish();
    assert_eq!(accepted, 1, "a working listing route needs no chat probe");
    assert!(
        requests[0].starts_with("GET /models HTTP/1.1"),
        "got: {}",
        requests[0]
    );
}

#[tokio::test]
async fn test_connection_falls_back_to_chat_when_models_is_missing() {
    // Two sequential connections: the listing route 404s, the chat route answers.
    let mock = MockServer::start(vec![
        (404, r#"{"error":{"message":"not found"}}"#),
        (200, r#"{"choices":[{"message":{"content":"pong"}}]}"#),
    ]);
    let client = probe_client();
    let report = client
        .test_connection(&mock.base, "model-a", "sk-test")
        .await;

    assert!(report.ok, "detail: {}", report.detail);
    assert_eq!(report.via, Some("probe"));
    assert!(report.models.is_empty());
    assert!(report.latency_ms.is_some());

    let (requests, accepted) = mock.finish();
    assert_eq!(accepted, 2, "one listing attempt, then one chat probe");
    assert!(
        requests[0].starts_with("GET /models HTTP/1.1"),
        "got: {}",
        requests[0]
    );
    assert!(
        requests[1].starts_with("POST /chat/completions HTTP/1.1"),
        "got: {}",
        requests[1]
    );
    assert!(
        requests[1].contains("\"max_tokens\":1"),
        "probe must stay cheap: {}",
        requests[1]
    );
    assert!(
        requests[1].contains("\"stream\":false"),
        "probe must not stream: {}",
        requests[1]
    );
}

#[tokio::test]
async fn test_connection_does_not_fall_back_on_401() {
    let mock = MockServer::start(vec![(401, r#"{"error":{"message":"invalid api key"}}"#)]);
    let client = probe_client();
    let report = client
        .test_connection(&mock.base, "model-a", "bad-key")
        .await;

    assert!(!report.ok);
    assert!(report.detail.contains("401"), "got: {}", report.detail);
    assert!(
        report.detail.contains("invalid api key"),
        "got: {}",
        report.detail
    );
    assert_eq!(report.via, None);
    assert!(report.latency_ms.is_none());

    let (requests, accepted) = mock.finish();
    assert_eq!(
        accepted, 1,
        "a 401 is decisive; extra requests: {requests:?}"
    );
    assert!(
        !requests.iter().any(|r| r.starts_with("POST ")),
        "the chat probe must not run: {requests:?}"
    );
}

#[tokio::test]
async fn test_connection_rejects_blank_inputs_without_a_request() {
    let mock = MockServer::start(Vec::new());
    let client = probe_client();

    for (base, model, key) in [
        ("", "model-a", "sk-test"),
        (mock.base.as_str(), "", "sk-test"),
        (mock.base.as_str(), "model-a", ""),
    ] {
        let report = client.test_connection(base, model, key).await;
        assert!(!report.ok);
        assert!(!report.detail.is_empty());
        assert_eq!(report.via, None);
        assert!(report.latency_ms.is_none());
    }

    let (requests, accepted) = mock.finish();
    assert_eq!(
        accepted, 0,
        "blank input must be caught before the network: {requests:?}"
    );
}

#[tokio::test]
async fn test_connection_reports_transport_failure() {
    // Bind then drop: the kernel refuses the connection immediately, unlike a
    // blackholed address that would sit in the client's 10s connect timeout.
    let port = {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        listener.local_addr().unwrap().port()
    };

    let client = probe_client();
    let report = client
        .test_connection(&format!("http://127.0.0.1:{port}"), "model-a", "sk-test")
        .await;

    assert!(!report.ok, "detail: {}", report.detail);
    assert!(
        report.detail.contains("无法连接"),
        "got: {}",
        report.detail
    );
    assert_eq!(report.via, None);
    assert!(report.latency_ms.is_none());
}
