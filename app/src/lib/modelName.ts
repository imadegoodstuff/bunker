/** "orbio:openai/gpt-6-luna" → { name: "GPT-6 Luna", vendor: "OpenAI" }. Falls back to the raw id. */
const VENDORS: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google", "x-ai": "xAI", xai: "xAI", meta: "Meta", mistral: "Mistral", deepseek: "DeepSeek", qwen: "Qwen" };
const ACRONYMS = new Set(["gpt", "o1", "o3", "o4", "xl", "ai"]);

export function modelName(id: string | undefined): { name: string; vendor: string } {
  if (!id) return { name: "—", vendor: "" };
  const path = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  const [vendorRaw, modelRaw] = path.includes("/") ? [path.slice(0, path.indexOf("/")), path.slice(path.indexOf("/") + 1)] : ["", path];
  const name = modelRaw
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : /^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/^(GPT|Claude|Gemini|Grok|Llama) (\d)/, "$1-$2");
  return { name, vendor: VENDORS[vendorRaw.toLowerCase()] ?? (vendorRaw ? vendorRaw[0].toUpperCase() + vendorRaw.slice(1) : "") };
}
