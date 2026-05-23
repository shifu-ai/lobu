import { createServer } from "node:http";
const PORT = Number(process.env.MOCK_PORT || 11434);
const REPLY = process.env.MOCK_REPLY || "PONG";
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = req.url || "";
    if (url.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "mock-model", object: "model" }],
        })
      );
      return;
    }
    if (url.includes("/chat/completions")) {
      let stream = false;
      try {
        stream = JSON.parse(body || "{}").stream === true;
      } catch {
        // non-JSON body → default to non-streaming
      }
      if (stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        const id = "chatcmpl-mock";
        const chunk = (delta, finish) =>
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "mock-model", choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;
        res.write(chunk({ role: "assistant" }));
        res.write(chunk({ content: REPLY }));
        res.write(chunk({}, "stop"));
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion",
            model: "mock-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: REPLY },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
      }
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
});
server.listen(PORT, "127.0.0.1", () =>
  console.log(`[mock-openai] listening on 127.0.0.1:${PORT}`)
);
