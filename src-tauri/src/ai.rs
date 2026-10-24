//! DeepSeek (OpenAI-compatible) vision requests.
//!
//! The API key never reaches the webview: the frontend hands over a `crop_id`,
//! this module pulls the PNG out of the session store, and streams text back
//! through Tauri events.

use crate::types::{AiAction, AiDelta, AiDone};
use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Prompts are fixed here rather than in the frontend so a compromised webview
/// cannot rewrite them. Only [`AiAction::Ask`] accepts free-form text.
pub fn prompt_for(action: AiAction, lang: Option<&str>, question: Option<&str>) -> (String, String) {
    let system = "你是一个精确的截图助手。只输出结果本身，不要寒暄、不要重复指令、不要添加解释性前后缀。";
    let user = match action {
        AiAction::Extract => {
            "逐字提取这张截图中的全部文字。严格保留原始换行与段落顺序。\
             不要翻译，不要总结，不要补全看不清的内容；无法辨认处用 [无法辨认] 标记。"
                .to_string()
        }
        AiAction::Translate => {
            let lang = lang.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("简体中文");
            format!(
                "把这张截图中的文字翻译成{lang}。只输出译文，保留原有的分段与顺序；\
                 若图中没有文字，直接回答“未检测到文字”。"
            )
        }
        AiAction::Explain => {
            "说明这张截图展示的内容：先一句话概括，再分条列出关键信息（界面元素、数据、可能的用途）。\
             用简体中文，控制在 150 字以内。"
                .to_string()
        }
        AiAction::Ask => {
            let q = question.map(str::trim).unwrap_or("");
            if q.is_empty() {
                "描述这张截图。".to_string()
            } else {
                q.to_string()
            }
        }
        AiAction::Reply => {
            "这是对话/聊天场景的截图。请代写一条高情商回复：先理解上下文与对方立场，\
             回复要得体、自然、有分寸，既不生硬也不谄媚。只输出可以直接发送的回复内容本身，\
             不要出现“回复：”之类的前缀；若截图并非对话，请说明无法代写回复。"
                .to_string()
        }
    };
    (system.to_string(), user)
}

/// Build the OpenAI-compatible request body.
pub fn request_body(model: &str, system: &str, user: &str, png: &[u8]) -> Value {
    let data_url = crate::output::data_url(png);
    json!({
        "model": model,
        "stream": true,
        "temperature": 0.2,
        "messages": [
            { "role": "system", "content": system },
            {
                "role": "user",
                "content": [
                    { "type": "text", "text": user },
                    { "type": "image_url", "image_url": { "url": data_url, "detail": "original" } }
                ]
            }
        ]
    })
}

/// Join a base URL with the chat completions path, tolerating either form.
pub fn endpoint(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/chat/completions")
    }
}

/// Join a base URL with the model listing path.
///
/// Providers disagree on where `/models` lives: OpenAI and most proxies put it
/// next to `/v1`, while DeepSeek serves it from the bare host. A base URL that
/// already names `/chat/completions` is trimmed back to its root so the same
/// field can hold either shape the user copied from the provider's docs.
pub fn models_endpoint(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        return format!("{}/models", base.trim_end_matches("/chat/completions"));
    }
    format!("{base}/models")
}

/// Pull the model ids out of a `GET /models` body.
///
/// Only the OpenAI shape (`{"data":[{"id":"..."}]}`) is understood. Anything
/// else yields an empty list instead of an error: a provider that answers with
/// a different schema should not stop the user from typing a model by hand.
pub fn parse_models(body: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };
    let Some(items) = value.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out: Vec<String> = items
        .iter()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Whether a base URL points at this machine (the local Ollama preset).
///
/// reqwest is built with `macos-system-configuration`, so it honours the
/// machine's HTTP proxy. Without this check, `http://127.0.0.1:11434` would be
/// sent *through* that proxy: either a 502, or worse, the user's local model
/// traffic leaving the machine. Loopback is always direct.
pub fn is_loopback(base_url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base_url.trim()) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") || host.to_ascii_lowercase().ends_with(".localhost") {
        return true;
    }
    host.parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

/// Build an HTTP client. `direct` disables proxy discovery entirely.
fn build_client(direct: bool, timeout: Duration, connect_timeout: Duration) -> Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(connect_timeout);
    if direct {
        builder = builder.no_proxy();
    }
    builder.build().context("build http client")
}

/// The two transports every client in this module keeps: proxied and direct.
///
/// Clients are pooled, so both variants are built once. `for_url` picks between
/// them per request rather than per client, because the settings page can probe
/// a remote endpoint and local Ollama in the same session.
struct Transports {
    proxied: reqwest::Client,
    direct: reqwest::Client,
}

impl Transports {
    fn new(timeout: Duration, connect_timeout: Duration) -> Result<Self> {
        Ok(Self {
            proxied: build_client(false, timeout, connect_timeout)?,
            direct: build_client(true, timeout, connect_timeout)?,
        })
    }

    fn for_url(&self, base_url: &str) -> &reqwest::Client {
        if is_loopback(base_url) {
            &self.direct
        } else {
            &self.proxied
        }
    }
}

/// Extract one SSE payload's text delta, if it carries any.
pub fn delta_from_sse(data: &str) -> Option<String> {
    let value: Value = serde_json::from_str(data).ok()?;
    if let Some(err) = value.get("error") {
        let msg = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("upstream error");
        return Some(format!("\u{0}ERROR:{msg}"));
    }
    let choice = value.get("choices")?.get(0)?;
    let delta = choice.get("delta")?;
    // DeepSeek may return reasoning_content alongside content; only surface content.
    delta
        .get("content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

#[derive(Default)]
pub struct SseBuffer {
    buf: String,
}

impl SseBuffer {
    /// Feed bytes, returning every complete SSE `data:` payload found.
    pub fn push(&mut self, chunk: &str) -> Vec<String> {
        self.buf.push_str(chunk);
        let mut out = Vec::new();
        loop {
            let Some(pos) = self.buf.find('\n') else { break };
            let line: String = self.buf.drain(..=pos).collect();
            let line = line.trim_end_matches(['\r', '\n']);
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim_start();
                if data.is_empty() {
                    continue;
                }
                out.push(data.to_string());
            }
        }
        out
    }
}

pub struct AiClient {
    http: Transports,
}

impl AiClient {
    pub fn new() -> Result<Self> {
        Ok(Self {
            http: Transports::new(Duration::from_secs(120), Duration::from_secs(15))?,
        })
    }

    /// Stream one answer, emitting `ai://delta` / `ai://done`.
    /// Transport core: POST the request and hand every text delta to `on_delta`.
    ///
    /// Kept free of `AppHandle` so it can be exercised against a mock server.
    pub async fn stream_with<F>(
        &self,
        base_url: &str,
        model: &str,
        api_key: &str,
        action: AiAction,
        lang: Option<&str>,
        question: Option<&str>,
        png: &[u8],
        mut on_delta: F,
    ) -> Result<()>
    where
        F: FnMut(String),
    {
        let (system, user) = prompt_for(action, lang, question);
        let body = request_body(model, &system, &user, png);

        let response = self
            .http
            .for_url(base_url)
            .post(endpoint(base_url))
            .bearer_auth(api_key)
            .header("Accept", "text/event-stream")
            .json(&body)
            .send()
            .await
            .context("send request")?;

        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            let detail = extract_error(&text).unwrap_or(text);
            return Err(anyhow!("模型返回 {status}: {detail}"));
        }

        let mut stream = response.bytes_stream();
        let mut sse = SseBuffer::default();
        let mut emitted = false;

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("read stream")?;
            let text = String::from_utf8_lossy(&chunk);
            for payload in sse.push(&text) {
                if payload == "[DONE]" {
                    if !emitted {
                        return Err(anyhow!("模型没有返回任何内容"));
                    }
                    return Ok(());
                }
                if let Some(delta) = delta_from_sse(&payload) {
                    if let Some(msg) = delta.strip_prefix('\u{0}') {
                        return Err(anyhow!("{}", msg.trim_start_matches("ERROR:")));
                    }
                    emitted = true;
                    on_delta(delta);
                }
            }
        }

        if !emitted {
            return Err(anyhow!("模型没有返回任何内容"));
        }
        Ok(())
    }

    /// Emit deltas to the webview while streaming.
    #[allow(clippy::too_many_arguments)]
    pub async fn stream(
        &self,
        app: &AppHandle,
        request_id: &str,
        base_url: &str,
        model: &str,
        api_key: &str,
        action: AiAction,
        lang: Option<&str>,
        question: Option<&str>,
        png: &[u8],
    ) -> Result<()> {
        let request_id = request_id.to_string();
        self.stream_with(base_url, model, api_key, action, lang, question, png, |text| {
            let _ = app.emit(
                "ai://delta",
                AiDelta { request_id: request_id.clone(), text },
            );
        })
        .await
    }
}

fn extract_error(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    value
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Verdict of the settings page's "test connection" button.
///
/// Failures are reported in-band (`ok: false`) instead of as an error: the UI
/// wants to show the upstream message next to the form, not in a dialog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionReport {
    pub ok: bool,
    /// Short verdict, already in the user's language.
    pub detail: String,
    /// Round trip of the request that decided the verdict.
    pub latency_ms: Option<u64>,
    /// Which probe answered.
    pub via: Option<&'static str>,
    /// Advertised model ids, empty when the endpoint has no `/models` route.
    pub models: Vec<String>,
}

impl ConnectionReport {
    /// Build a failure verdict for an error raised before the probe ran.
    pub fn failure(detail: impl Into<String>) -> Self {
        Self {
            ok: false,
            detail: detail.into(),
            latency_ms: None,
            via: None,
            models: Vec::new(),
        }
    }
}

/// Listing and connectivity probes for the settings page.
///
/// These never touch the session store and never stream: they exist so the user
/// can validate an endpoint before committing it to the config file.
pub struct ProbeClient {
    http: Transports,
}

impl ProbeClient {
    pub fn new() -> Result<Self> {
        Ok(Self {
            http: Transports::new(Duration::from_secs(30), Duration::from_secs(10))?,
        })
    }

    /// `GET {base}/models`, returning the ids the provider advertises.
    ///
    /// An endpoint without that route is not an error the caller has to handle
    /// specially: the probe falls back to a chat request, so the model dropdown
    /// simply stays empty and the user types a name.
    pub async fn list_models(&self, base_url: &str, api_key: &str) -> Result<Vec<String>> {
        let url = models_endpoint(base_url);
        let mut request = self
            .http
            .for_url(base_url)
            .get(&url)
            .header("Accept", "application/json");
        if !api_key.is_empty() {
            request = request.bearer_auth(api_key);
        }
        let response = request
            .send()
            .await
            .with_context(|| format!("请求 {url} 失败"))?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            let detail = extract_error(&body).unwrap_or_else(|| {
                if body.trim().is_empty() {
                    format!("HTTP {status}")
                } else {
                    body.chars().take(200).collect()
                }
            });
            return Err(anyhow!("获取模型列表失败（{status}）：{detail}"));
        }
        Ok(parse_models(&body))
    }

    /// Decide whether `base_url` + `model` + `api_key` can actually talk.
    ///
    /// Strategy: try `GET /models` first, because it is free and also gives the
    /// dropdown its data. If the endpoint has no such route (404/405 — common
    /// for proxies and some gateways), fall back to a one-token, non-streaming
    /// chat completion, which additionally proves the model name exists and the
    /// key is accepted. A 401/403 on `/models` is decisive and does not fall
    /// back: the key is wrong no matter which route we ask.
    pub async fn test_connection(
        &self,
        base_url: &str,
        model: &str,
        api_key: &str,
    ) -> ConnectionReport {
        let base_url = base_url.trim();
        let model = model.trim();
        if base_url.is_empty() {
            return ConnectionReport::failure("请先填写服务地址");
        }
        if model.is_empty() {
            return ConnectionReport::failure("请先选择或填写模型");
        }
        if api_key.is_empty() {
            return ConnectionReport::failure("尚未设置 API Key");
        }

        let started = std::time::Instant::now();
        let models_url = models_endpoint(base_url);
        let request = self
            .http
            .for_url(base_url)
            .get(&models_url)
            .header("Accept", "application/json")
            .bearer_auth(api_key);

        match request.send().await {
            Ok(response) => {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                if status.is_success() {
                    let models = parse_models(&body);
                    let elapsed = started.elapsed().as_millis() as u64;
                    let detail = if models.is_empty() {
                        "连接正常".to_string()
                    } else {
                        format!("连接正常，该端点提供 {} 个模型", models.len())
                    };
                    return ConnectionReport {
                        ok: true,
                        detail,
                        latency_ms: Some(elapsed),
                        via: Some("models"),
                        models,
                    };
                }
                // 404/405 means "no listing route", not "bad credentials".
                if !matches!(status.as_u16(), 404 | 405) {
                    let detail = extract_error(&body).unwrap_or_else(|| {
                        if body.trim().is_empty() {
                            format!("HTTP {status}")
                        } else {
                            body.chars().take(200).collect()
                        }
                    });
                    return ConnectionReport::failure(format!("{status}：{detail}"));
                }
            }
            Err(e) => {
                // A transport failure is final: the host is unreachable, so the
                // chat fallback would fail the same way.
                return ConnectionReport::failure(format!("无法连接到 {base_url}：{e}"));
            }
        }

        // No `/models` route; ask the chat endpoint directly.
        self.probe_chat(base_url, model, api_key).await
    }

    /// One-token, non-streaming completion used only to validate credentials.
    async fn probe_chat(&self, base_url: &str, model: &str, api_key: &str) -> ConnectionReport {
        let body = json!({
            "model": model,
            "max_tokens": 1,
            "stream": false,
            "messages": [{ "role": "user", "content": "ping" }],
        });
        let started = std::time::Instant::now();
        let response = match self
            .http
            .for_url(base_url)
            .post(endpoint(base_url))
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => return ConnectionReport::failure(format!("无法连接到 {base_url}：{e}")),
        };
        let elapsed = started.elapsed().as_millis() as u64;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();

        if !status.is_success() {
            let detail = extract_error(&text).unwrap_or_else(|| {
                if text.trim().is_empty() {
                    format!("HTTP {status}")
                } else {
                    text.chars().take(200).collect()
                }
            });
            // 404 here usually means the model name is wrong, which is worth
            // saying explicitly: it is the most common mistake in this form.
            let hint = if status.as_u16() == 404 {
                "（地址可达，但该模型不存在，请检查模型名）"
            } else {
                ""
            };
            return ConnectionReport::failure(format!("{status}：{detail}{hint}"));
        }

        ConnectionReport {
            ok: true,
            detail: format!("连接正常，模型 {model} 可用"),
            latency_ms: Some(elapsed),
            via: Some("probe"),
            models: Vec::new(),
        }
    }
}

/// Run a request and always finish with `ai://done`.
pub async fn run(app: AppHandle, request_id: String, png: Vec<u8>, task: AiTask) {
    let result = async {
        let settings = crate::settings::load_settings();
        let key = crate::settings::load_api_key()?;
        let client = AiClient::new()?;
        client
            .stream(
                &app,
                &request_id,
                &settings.base_url,
                &settings.model,
                &key,
                task.action,
                task.lang.as_deref(),
                task.question.as_deref(),
                &png,
            )
            .await
    }
    .await;

    let done = match result {
        Ok(()) => AiDone { request_id, ok: true, error: None },
        Err(e) => {
            log::warn!("ai request failed: {e:#}");
            AiDone { request_id, ok: false, error: Some(format!("{e:#}")) }
        }
    };
    let _ = app.emit("ai://done", done);
}

pub struct AiTask {
    pub action: AiAction,
    pub lang: Option<String>,
    pub question: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_accepts_bare_host() {
        assert_eq!(
            endpoint("https://api.deepseek.com"),
            "https://api.deepseek.com/chat/completions"
        );
    }

    #[test]
    fn endpoint_accepts_trailing_slash_and_path() {
        assert_eq!(
            endpoint("https://api.deepseek.com/"),
            "https://api.deepseek.com/chat/completions"
        );
        assert_eq!(
            endpoint("https://proxy.test/v1"),
            "https://proxy.test/v1/chat/completions"
        );
        assert_eq!(
            endpoint("https://proxy.test/chat/completions"),
            "https://proxy.test/chat/completions"
        );
    }

    #[test]
    fn models_endpoint_joins_the_listing_path() {
        assert_eq!(
            models_endpoint("https://api.deepseek.com"),
            "https://api.deepseek.com/models"
        );
        assert_eq!(
            models_endpoint("https://api.openai.com/v1/"),
            "https://api.openai.com/v1/models"
        );
        // A base URL pasted from the "endpoint" field already names the chat
        // path; the listing lives one level up.
        assert_eq!(
            models_endpoint("https://proxy.test/v1/chat/completions"),
            "https://proxy.test/v1/models"
        );
    }

    #[test]
    fn loopback_detection_covers_the_ollama_presets() {
        // The local preset must bypass the system proxy, or the user's own
        // model traffic leaves the machine.
        assert!(is_loopback("http://127.0.0.1:11434/v1"));
        assert!(is_loopback("http://localhost:11434/v1"));
        assert!(is_loopback("http://LOCALHOST:8080"));
        assert!(is_loopback("http://[::1]:11434/v1"));
        assert!(is_loopback("http://api.localhost/v1"));
        assert!(is_loopback("  http://127.0.0.1:11434/v1  "));

        assert!(!is_loopback("https://api.deepseek.com"));
        assert!(!is_loopback("http://192.168.1.10:11434/v1"));
        assert!(!is_loopback("http://10.0.0.5:11434/v1"));
        // Not a URL at all: treat as remote so the user's proxy still applies.
        assert!(!is_loopback("not a url"));
        assert!(!is_loopback(""));
    }

    #[test]
    fn body_carries_base64_image_and_model() {
        let body = request_body("deepseek-flash", "sys", "usr", b"\x89PNG");
        assert_eq!(body["model"], "deepseek-flash");
        assert_eq!(body["stream"], true);
        let parts = &body["messages"][1]["content"];
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts[1]["type"], "image_url");
        assert!(parts[1]["image_url"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }

    #[test]
    fn translate_prompt_uses_requested_language() {
        let (_, user) = prompt_for(AiAction::Translate, Some("English"), None);
        assert!(user.contains("English"));
        let (_, fallback) = prompt_for(AiAction::Translate, None, None);
        assert!(fallback.contains("简体中文"));
    }

    #[test]
    fn ask_prompt_passes_user_question_through() {
        let (_, user) = prompt_for(AiAction::Ask, None, Some("这个报错怎么修"));
        assert_eq!(user, "这个报错怎么修");
        let (_, empty) = prompt_for(AiAction::Ask, None, Some("   "));
        assert_eq!(empty, "描述这张截图。");
    }

    #[test]
    fn sse_buffer_handles_split_chunks() {
        let mut sse = SseBuffer::default();
        assert!(sse.push("data: {\"a\":").is_empty());
        let out = sse.push("1}\n\ndata: [DONE]\n");
        assert_eq!(out, vec!["{\"a\":1}".to_string(), "[DONE]".to_string()]);
    }

    #[test]
    fn sse_ignores_non_data_lines_and_keepalives() {
        let mut sse = SseBuffer::default();
        let out = sse.push(": keepalive\nevent: message\ndata: \n\ndata: {\"x\":1}\r\n");
        assert_eq!(out, vec!["{\"x\":1}".to_string()]);
    }

    #[test]
    fn delta_extracts_content_only() {
        let data = r#"{"choices":[{"delta":{"reasoning_content":"thinking","content":"你好"}}]}"#;
        assert_eq!(delta_from_sse(data).as_deref(), Some("你好"));
    }

    #[test]
    fn delta_skips_empty_and_missing_content() {
        assert!(delta_from_sse(r#"{"choices":[{"delta":{"role":"assistant"}}]}"#).is_none());
        assert!(delta_from_sse(r#"{"choices":[{"delta":{"content":""}}]}"#).is_none());
        assert!(delta_from_sse("not json").is_none());
    }

    #[test]
    fn delta_surfaces_upstream_error_marker() {
        let data = r#"{"error":{"message":"invalid api key"}}"#;
        let out = delta_from_sse(data).unwrap();
        assert_eq!(out, "\u{0}ERROR:invalid api key");
    }
}
