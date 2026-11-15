// Workers AI text drafting shared by the Mobius Workers.
//
// runDraft(env, messages, { maxTokens, accept }) tries Gemma 4 first (with thinking turned off),
// then Llama 3.3, and returns { text, model, accepted } or null. Models get retired: check the
// catalog (Cloudflare dashboard > Workers AI > Models) if both ever stop working.
//
// Gemma 4 is a reasoning model. Left alone it spends its whole token budget "thinking" and returns
// an empty answer, so we send chat_template_kwargs.enable_thinking = false. Only the final answer
// (message.content / response) is ever read, never the reasoning text.
//
// `accept(text)` is optional: return a truthy value to take the draft (it comes back as
// `accepted`), or a falsy value to move on to the next model.

const MODELS = [
  { id: "@cf/google/gemma-4-26b-a4b-it", extra: { chat_template_kwargs: { enable_thinking: false } } }, // about 5x fewer neurons per draft than Llama
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", extra: {} },
];

export function answerText(out) {
  return String(
    (out && (out.response || (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content) || out.result)) || ""
  ).trim();
}

export async function runDraft(env, messages, { maxTokens = 400, accept } = {}) {
  if (!env.AI) return null;
  for (const { id, extra } of MODELS) {
    try {
      const out = await env.AI.run(id, { messages, max_tokens: maxTokens, ...extra });
      const text = answerText(out);
      if (!text) {
        console.error(`ai: model ${id} returned no answer text`);
        continue;
      }
      if (!accept) return { text, model: id };
      const accepted = accept(text);
      if (accepted) return { text, model: id, accepted };
    } catch (e) {
      console.error(`ai: model ${id} failed:`, e && e.message);
    }
  }
  return null;
}
