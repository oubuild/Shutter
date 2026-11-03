//! Model download pipeline against a real local HTTP server.
//!
//! Same approach as `ai_stream.rs`: no network egress, no real models — a
//! hand-rolled server serves canned bytes so the SHA-256 accept/reject paths,
//! fallback sources, and progress callbacks are exercised deterministically.

use sha2::{Digest, Sha256};
use shutter_lib::ocr::models::{fetch_artifact, Artifact};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

fn sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Serve `responses` requests (status, body) in order, then stop. Returns the
/// base URL plus how many requests actually arrived.
fn serve(responses: Vec<(&'static str, Vec<u8>)>) -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().unwrap().port();
    let hits = Arc::new(AtomicUsize::new(0));
    let hits_clone = Arc::clone(&hits);

    thread::spawn(move || {
        for (status, body) in responses {
            let Ok((mut socket, _)) = listener.accept() else {
                return;
            };
            hits_clone.fetch_add(1, Ordering::SeqCst);
            // Drain the request head so the client is not blocked writing.
            let mut chunk = [0u8; 4096];
            let _ = socket.read(&mut chunk);
            let head = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = socket.write_all(head.as_bytes());
            let _ = socket.write_all(&body);
            let _ = socket.flush();
        }
    });

    (format!("http://127.0.0.1:{port}"), hits)
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("shutter-ocr-it-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Test-only constructor: leaks the URL list so `Artifact`'s 'static bounds
/// hold without ceremony at every call site.
fn artifact(filename: &'static str, sha256: &'static str, urls: Vec<String>) -> Artifact {
    let leaked: Vec<&'static str> = urls
        .into_iter()
        .map(|u| -> &'static str { Box::leak(u.into_boxed_str()) })
        .collect();
    Artifact {
        filename,
        sha256,
        urls: Box::leak(leaked.into_boxed_slice()),
    }
}

const NOOP: fn(&str, u64, Option<u64>) = |_, _, _| {};

#[tokio::test]
async fn installs_when_hash_matches_and_reports_progress() {
    let body = b"fake onnx weights, not really a model".to_vec();
    let (url, _hits) = serve(vec![("200 OK", body.clone())]);
    let sha: &'static str = Box::leak(sha256(&body).into_boxed_str());
    let art = artifact("det.onnx", sha, vec![url]);

    let dir = temp_dir("install");
    let dest = dir.join("det.onnx");
    let seen: Arc<Mutex<Vec<(u64, Option<u64>)>>> = Arc::new(Mutex::new(Vec::new()));
    let seen_cb = Arc::clone(&seen);
    let progress = move |_f: &str, downloaded: u64, total: Option<u64>| {
        seen_cb.lock().unwrap().push((downloaded, total));
    };

    fetch_artifact(&art, &dest, &progress).await.expect("install");

    assert_eq!(std::fs::read(&dest).unwrap(), body);
    assert!(!dir.join("det.part").exists(), "no partial file may survive");

    let events = seen.lock().unwrap();
    assert!(!events.is_empty(), "progress must be reported");
    assert_eq!(events.last().unwrap(), &(body.len() as u64, Some(body.len() as u64)));
    // Monotonic byte counts.
    assert!(
        events.windows(2).all(|pair| pair[0].0 <= pair[1].0),
        "progress must never go backwards: {events:?}"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn rejects_hash_mismatch_and_keeps_existing_file() {
    let dir = temp_dir("mismatch");
    let dest = dir.join("rec.onnx");
    std::fs::write(&dest, b"previous good install").unwrap();

    let (url, hits) = serve(vec![("200 OK", b"tampered bytes".to_vec())]);
    // Pin the hash of something other than what the server will send.
    let wrong_sha: &'static str =
        Box::leak(sha256(b"honest bytes").into_boxed_str());
    let art = artifact("rec.onnx", wrong_sha, vec![url]);

    let err = fetch_artifact(&art, &dest, &NOOP).await.expect_err("must reject");
    assert!(format!("{err:#}").contains("SHA-256"), "error should name the check: {err:#}");

    assert_eq!(std::fs::read(&dest).unwrap(), b"previous good install");
    assert!(!dir.join("rec.part").exists(), "partial file must be cleaned up");
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn falls_back_to_the_second_source() {
    let body = b"weights from the mirror".to_vec();
    let (primary, hits_primary) = serve(vec![("404 Not Found", b"gone".to_vec())]);
    let (fallback, _hits) = serve(vec![("200 OK", body.clone())]);
    let sha: &'static str = Box::leak(sha256(&body).into_boxed_str());
    let art = artifact("dict.txt", sha, vec![primary, fallback]);

    let dir = temp_dir("fallback");
    let dest = dir.join("dict.txt");
    fetch_artifact(&art, &dest, &NOOP).await.expect("fallback install");

    assert_eq!(std::fs::read(&dest).unwrap(), body);
    assert_eq!(hits_primary.load(Ordering::SeqCst), 1, "primary must have been tried first");
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn fails_when_every_source_is_down() {
    let (url, hits) = serve(vec![("500 Internal Server Error", b"".to_vec())]);
    let art = artifact("gone.onnx", "0000", vec![url]);

    let dir = temp_dir("dead");
    let dest = dir.join("gone.onnx");
    assert!(fetch_artifact(&art, &dest, &NOOP).await.is_err());
    assert!(!dest.exists(), "nothing may be installed on failure");
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    std::fs::remove_dir_all(&dir).ok();
}
