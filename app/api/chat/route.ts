import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type ChatBody = {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
};

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

    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(body.apiKey?.trim() ? { Authorization: `Bearer ${body.apiKey.trim()}` } : {}),
      },
      body: JSON.stringify({
        model: body.model.trim(),
        messages: body.messages,
        temperature: body.temperature ?? 0.7,
      }),
      signal: AbortSignal.timeout(90_000),
    });

    const raw = await upstream.text();
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return NextResponse.json(
        { error: `上游 API 返回了非 JSON 内容（HTTP ${upstream.status}）。`, raw },
        { status: 502 },
      );
    }

    if (!upstream.ok) {
      const upstreamError =
        typeof data === "object" && data && "error" in data
          ? (data as { error: unknown }).error
          : null;
      const message =
        typeof upstreamError === "object" && upstreamError && "message" in upstreamError
          ? String((upstreamError as { message: unknown }).message)
          : upstreamError
            ? JSON.stringify(upstreamError)
            : raw;
      return NextResponse.json({ error: `模型 API 调用失败（HTTP ${upstream.status}）：${message}` }, { status: 502 });
    }

    const content = (data as { choices?: Array<{ message?: { content?: string } }> })
      ?.choices?.[0]?.message?.content;
    if (!content) {
      return NextResponse.json({ error: "模型 API 响应中没有 choices[0].message.content。", raw }, { status: 502 });
    }
    return NextResponse.json({ content, usage: (data as { usage?: unknown }).usage ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return NextResponse.json({ error: message.includes("timeout") ? "模型响应超时，请稍后重试。" : message }, { status: 500 });
  }
}
