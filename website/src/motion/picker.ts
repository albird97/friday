import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { chatTimeline, replay } from "./chat";

const AUTO_SECONDS = 7;

/** Tabs for the feature list. They work without animation too: `animate` only decides whether the chat plays. */
export function featurePicker(root: HTMLElement, animate: boolean): void {
  const list = root.querySelector<HTMLElement>(".picker__tabs")!;
  const lead = root.querySelector<HTMLElement>(".picker__lead")!;
  const tabs = gsap.utils.toArray<HTMLButtonElement>(".picker__tab", root);
  const panels = gsap.utils.toArray<HTMLElement>(".panel", root);
  const timelines = new Map<number, gsap.core.Timeline>();
  let current = 0;
  let auto: gsap.core.Tween | undefined;
  let touched = false;

  list.setAttribute("role", "tablist");
  list.setAttribute("aria-label", "Fitur Friday");
  tabs.forEach((tab, i) => {
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", panels[i].id);
    tab.tabIndex = i === 0 ? 0 : -1;
    panels[i].setAttribute("role", "tabpanel");
    panels[i].setAttribute("aria-labelledby", tab.id);
  });

  function select(next: number, focus = false) {
    timelines.get(current)?.pause();
    tabs[current].setAttribute("aria-selected", "false");
    tabs[current].tabIndex = -1;
    panels[current].dataset.active = "false";
    current = next;
    const tab = tabs[current];
    tab.setAttribute("aria-selected", "true");
    tab.tabIndex = 0;
    panels[current].dataset.active = "true";
    lead.textContent = tab.querySelector(".picker__summary")?.textContent ?? "";
    // Phones show the tabs as a sideways row; keep the chosen one in view without moving the page.
    list.scrollTo({ left: tab.offsetLeft - (list.clientWidth - tab.offsetWidth) / 2, behavior: animate ? "smooth" : "auto" });
    if (focus) tab.focus({ preventScroll: true });
    if (!animate) return;
    const chat = panels[current].querySelector<HTMLElement>(".chat")!;
    const timeline = timelines.get(current) ?? chatTimeline(chat);
    timelines.set(current, timeline);
    replay(timeline, chat);
  }

  const takeOver = () => {
    touched = true;
    auto?.kill();
  };
  const queueAuto = () => {
    auto = gsap.delayedCall(AUTO_SECONDS, () => {
      select((current + 1) % tabs.length);
      queueAuto();
    });
  };

  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => {
      takeOver();
      select(i);
    });
    tab.addEventListener("keydown", (event) => {
      const move: Record<string, number> = {
        ArrowDown: (current + 1) % tabs.length,
        ArrowRight: (current + 1) % tabs.length,
        ArrowUp: (current - 1 + tabs.length) % tabs.length,
        ArrowLeft: (current - 1 + tabs.length) % tabs.length,
        Home: 0,
        End: tabs.length - 1,
      };
      if (!(event.key in move)) return;
      event.preventDefault();
      takeOver();
      select(move[event.key], true);
    });
  });

  if (!animate) return;
  ScrollTrigger.create({
    trigger: root,
    start: "top 70%",
    end: "bottom 30%",
    onToggle: ({ isActive }) => {
      auto?.kill();
      if (isActive && !touched) queueAuto();
    },
  });
}
