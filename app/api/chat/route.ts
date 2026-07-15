import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_MODEL_TIMEOUT_MS = 10 * 60 * 1000;

type ChatBody = {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
};

type ChatResult =
  | { ok: true; content: string; usage: unknown }
  | {
    ok: false;
    status: number;
    error: string;
    details?: string;
    upstreamStatus?: number;
    upstreamRaw?: string;
  };

type EmitToken = (token: string) => void;

function modelTimeoutMs() {
  const raw = Number(process.env.MODEL_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MODEL_TIMEOUT_MS;
  return Math.max(30_000, Math.min(raw, 30 * 60 * 1000));
}

function summarizeRaw(raw: string) {
  return raw.length > 1200 ? `${raw.slice(0, 1200)}...` : raw;
}

function stringifyErrorValue(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const message = record.message ?? record.msg ?? record.code ?? record.type;
    if (message) return String(message);
    return JSON.stringify(value);
  }
  return value ? String(value) : "";
}

function parseModelJsonResponse(data: unknown, raw: string, upstreamStatus: number): ChatResult {
  const content = (data as { choices?: Array<{ message?: { content?: string } }> })
    ?.choices?.[0]?.message?.content;
  if (!content) {
    return {
      ok: false,
      status: 502,
      error: "模型 API 响应中没有 choices[0].message.content。",
      details: "这通常表示该接入点返回格式不是 OpenAI-compatible chat/completions。",
      upstreamStatus,
      upstreamRaw: summarizeRaw(raw),
    };
  }
  return { ok: true, content, usage: (data as { usage?: unknown }).usage ?? null };
}

async function readJsonUpstream(upstream: Response): Promise<ChatResult> {
  const raw = await upstream.text();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      status: 502,
      error: `上游 API 返回了非 JSON 内容（HTTP ${upstream.status}）。`,
      details: "这通常表示 API 地址被网关、登录页、反向代理或平台错误页拦截了。",
      upstreamStatus: upstream.status,
      upstreamRaw: summarizeRaw(raw),
    };
  }

  if (!upstream.ok) {
    const record = typeof data === "object" && data ? data as Record<string, unknown> : {};
    const upstreamError = record.error ?? record.message ?? record.msg ?? record;
    const message = stringifyErrorValue(upstreamError) || raw;
    return {
      ok: false,
      status: 502,
      error: `模型 API 调用失败（HTTP ${upstream.status}）：${message}`,
      details: JSON.stringify(data),
      upstreamStatus: upstream.status,
      upstreamRaw: summarizeRaw(raw),
    };
  }

  return parseModelJsonResponse(data, raw, upstream.status);
}

function parseStreamPayload(payload: string) {
  try {
    const data = JSON.parse(payload) as {
      choices?: Array<{
        delta?: { content?: string };
        message?: { content?: string };
      }>;
      usage?: unknown;
    };
    return {
      token: data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content ?? "",
      usage: data.usage ?? null,
    };
  } catch {
    return { token: "", usage: null };
  }
}

async function readStreamingUpstream(upstream: Response, emitToken?: EmitToken): Promise<ChatResult> {
  if (!upstream.ok) return readJsonUpstream(upstream);
  if (!upstream.body) return readJsonUpstream(upstream);

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage: unknown = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
      if (!payload || payload === "[DONE]") continue;
      const parsed = parseStreamPayload(payload);
      if (parsed.usage) usage = parsed.usage;
      if (parsed.token) {
        content += parsed.token;
        emitToken?.(parsed.token);
      }
    }
  }

  if (buffer.trim()) {
    const payload = buffer.trim().startsWith("data:") ? buffer.trim().slice(5).trim() : buffer.trim();
    if (payload && payload !== "[DONE]") {
      const parsed = parseStreamPayload(payload);
      if (parsed.usage) usage = parsed.usage;
      if (parsed.token) {
        content += parsed.token;
        emitToken?.(parsed.token);
      }
    }
  }

  if (!content.trim()) {
    return {
      ok: false,
      status: 502,
      error: "模型流式响应结束，但没有返回可展示内容。",
      details: "请确认该模型接入点支持 OpenAI-compatible stream: true 响应。",
      upstreamStatus: upstream.status,
    };
  }

  return { ok: true, content, usage };
}

async function requestUpstream(body: ChatBody, endpoint: string, emitToken?: EmitToken): Promise<ChatResult> {
  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(body.apiKey?.trim() ? { Authorization: `Bearer ${body.apiKey.trim()}` } : {}),
      },
      body: JSON.stringify({
        model: body.model?.trim(),
        messages: body.messages,
        temperature: body.temperature ?? 0.7,
        ...(typeof body.maxTokens === "number" ? { max_tokens: body.maxTokens } : {}),
        ...(body.stream ? { stream: true } : {}),
      }),
      signal: AbortSignal.timeout(modelTimeoutMs()),
    });

    if (body.stream) return readStreamingUpstream(upstream, emitToken);
    return readJsonUpstream(upstream);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return {
      ok: false,
      status: 500,
      error: message.includes("timeout") ? "模型响应超时，请稍后重试。" : message,
    };
  }
}

function streamChat(body: ChatBody, endpoint: string) {
  const encoder = new TextEncoder();
  const line = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(line({ type: "ping", message: "connected", timestamp: Date.now() }));
      const heartbeat = setInterval(() => {
        controller.enqueue(line({ type: "ping", message: "waiting", timestamp: Date.now() }));
      }, 5000);

      requestUpstream(body, endpoint, (token) => {
        controller.enqueue(line({ type: "chunk", content: token }));
      })
        .then((result) => {
          clearInterval(heartbeat);
          if (result.ok) {
            controller.enqueue(line({ type: "result", content: result.content, usage: result.usage }));
          } else {
            controller.enqueue(line({ type: "error", ...result }));
          }
        })
        .catch((error) => {
          clearInterval(heartbeat);
          controller.enqueue(line({
            type: "error",
            status: 500,
            error: error instanceof Error ? error.message : "未知错误",
          }));
        })
        .finally(() => controller.close());
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ChatBody;
    const endpoint = body.endpoint?.trim();
    if (!endpoint || !body.model?.trim() || !body.messages?.length) {
      return NextResponse.json({ error: "请填写 API 地址、模型名称并提供消息内容。" }, { status: 400 });
    }
    if (!/^https?:\/\//i.test(endpoint)) {
      return NextResponse.json({ error: "API 地址必须以 http:// 或 https:// 开头。" }, { status: 400 });
    }
    if (body.apiKey?.trim().startsWith("ark-") && /api\.openai\.com/i.test(endpoint)) {
      return NextResponse.json(
        {
          error:
            "API 配置不匹配：当前 Key 是火山方舟的 ark- Key，但 API 地址填写的是 OpenAI。请将 API 地址改为 https://ark.cn-beijing.volces.com/api/v3/chat/completions，并填写方舟模型 ID 或推理接入点 ID。",
        },
        { status: 400 },
      );
    }

    if (body.stream) return streamChat(body, endpoint);

    const result = await requestUpstream(body, endpoint);
    if (!result.ok) return NextResponse.json(result, { status: result.status });
    return NextResponse.json({ content: result.content, usage: result.usage });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return NextResponse.json({ error: message.includes("timeout") ? "模型响应超时，请稍后重试。" : message }, { status: 500 });
  }
}
