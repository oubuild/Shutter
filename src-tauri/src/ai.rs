//! DeepSeek (OpenAI-compatible) vision requests.
//!
//! The API key never reaches the webview: the frontend hands over a `crop_id`,
//! this module pulls the PNG out of the session store, and streams text back
//! through Tauri events.

use crate::types::{AiAction, AiDelta, AiDone};
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::StreamExt;
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
    };
    (system.to_string(), user)
}

/// Build the OpenAI-compatible request body.
pub fn request_body(model: &str, system: &str, user: &str, png: &[u8]) -> Value {
    let data_url = format!("data:image/png;base64,{}", STANDARD.encode(png));
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
    http: reqwest::Client,
}

impl AiClient {
    pub fn new() -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .connect_timeout(Duration::from_secs(15))
            .build()
            .context("build http client")?;
        Ok(Self { http })
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
