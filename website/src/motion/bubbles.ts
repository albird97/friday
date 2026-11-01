import gsap from "gsap";

// Rich bubbles do a little more than appear. Each reveal ends on the bubble's finished look, which is also how it reads
// without any of this.
const reveals: Record<string, (bubble: HTMLElement) => gsap.core.Timeline> = {
  voice: (bubble) =>
    gsap.timeline().fromTo(
      bubble.querySelectorAll(".voice__bar"),
      { scaleY: 0.35, opacity: 0.35 },
      { scaleY: 1, opacity: 1, stagger: 0.025, duration: 0.3, ease: "power2.out" },
    ),
  file: (bubble) =>
    gsap.timeline().fromTo(
      bubble.querySelectorAll(".file__row"),
      { autoAlpha: 0 },
      { autoAlpha: 1, stagger: 0.14, duration: 0.3, ease: "none" },
    ),
  image: (bubble) =>
    gsap.timeline().fromTo(bubble.querySelector(".image__blur"), { opacity: 1 }, { opacity: 0, duration: 0.9, ease: "power2.out" }),
  poll: (bubble) => {
    const timeline = gsap.timeline().fromTo(
      bubble.querySelectorAll(".poll__bar"),
      { scaleX: 0 },
      { scaleX: 1, stagger: 0.1, duration: 0.8, ease: "expo.out" },
    );
    for (const votes of bubble.querySelectorAll<HTMLElement>(".poll__votes")) {
      // Kept on the element: the story rebuilds its timelines when the layout changes.
      votes.dataset.votes ??= votes.textContent ?? "0";
      const count = { value: 0 };
      votes.textContent = "0";
      timeline.to(count, {
        value: Number(votes.dataset.votes),
        duration: 0.8,
        ease: "power2.out",
        onUpdate: () => {
          votes.textContent = String(Math.round(count.value));
        },
      }, 0);
    }
    return timeline;
  },
};

export const richReveal = (bubble: HTMLElement) => reveals[bubble.dataset.kind ?? ""]?.(bubble) ?? gsap.timeline();
