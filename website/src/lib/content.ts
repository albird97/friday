import catalog from "../../../catalog/items.json";
import demosJson from "../content/demos.json";
import faqJson from "../content/faq.json";
import siteJson from "../content/site.json";

export type Sky = "pagi" | "siang" | "sore" | "senja" | "malam";
export type PollOption = { label: string; votes: number };
export type Bubble = { from: "me" | "friday"; time?: string } & (
  | { kind: "text"; text: string }
  | { kind: "voice"; seconds: number }
  | { kind: "image"; src: string; alt: string; caption?: string }
  | { kind: "file"; fileName: string; ext: string; meta: string; preview?: string[][] }
  | { kind: "poll"; question: string; options: PollOption[] }
);
export type Demo = { chat: string; subtitle?: string; thread: Bubble[]; story?: { time: string; sky: Sky; caption: string } };
export type Feature = { id: string; name: string; summary: string; demo: Demo };

const demos = demosJson as unknown as Record<string, Demo>;

export const site = siteJson;
export const faq = faqJson as { q: string; a: string; link?: string; linkText?: string }[];

// The catalog's description ends with an example for WhatsApp; the site shows that example as a chat instead.
export const features: Feature[] = catalog.map((item) => ({
  id: item.id,
  name: item.name,
  summary: item.description.split("\n\n")[0],
  demo: demos[item.id],
}));

export const storyScenes = features
  .filter((feature) => feature.demo.story)
  .sort((a, b) => a.demo.story!.time.localeCompare(b.demo.story!.time));

export const prompts = features.flatMap((feature) => {
  const first = feature.demo.thread.find((bubble) => bubble.from === "me" && bubble.kind === "text");
  return first?.kind === "text" ? [first.text] : [];
});

export const ctaUrl = `https://wa.me/${site.botNumber}?text=${encodeURIComponent(site.requestText)}`;
