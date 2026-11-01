import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import "lenis/dist/lenis.css";
import { heroChat } from "./hero";
import { featurePicker } from "./picker";
import { pageMotion } from "./sections";
import { dayStory } from "./story";

gsap.registerPlugin(ScrollTrigger);
ScrollTrigger.config({ ignoreMobileResize: true });

type NetworkInfo = { connection?: { saveData?: boolean } };

const lite =
  matchMedia("(prefers-reduced-motion: reduce)").matches || Boolean((navigator as Navigator & NetworkInfo).connection?.saveData);

async function start() {
  const picker = document.querySelector<HTMLElement>(".picker");
  if (picker) featurePicker(picker, !lite);
  if (lite) return;

  await document.fonts.ready;
  document.documentElement.classList.add("motion");

  if (matchMedia("(pointer: fine)").matches) {
    const lenis = new Lenis({ lerp: 0.12, anchors: true });
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add((time) => lenis.raf(time * 1000));
    gsap.ticker.lagSmoothing(0);
  }

  const hero = document.querySelector<HTMLElement>(".hero");
  if (hero) heroChat(hero);

  const story = document.querySelector<HTMLElement>(".story");
  if (story) {
    // Chat measurements depend on the phone's size, so the story rebuilds when the layout changes.
    gsap.matchMedia().add({ wide: "(min-width: 900px)", narrow: "(max-width: 899px)" }, () => dayStory(story));
  }

  pageMotion();
  // The story changes the page's height, so triggers made before it need new positions.
  ScrollTrigger.refresh();
}

void start();
