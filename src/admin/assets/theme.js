// Runs before the page paints, so a chosen theme never flashes the other one first. "system" (nothing stored) follows the OS.
try {
  const theme = localStorage.getItem("friday-theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {
  // storage blocked: follow the OS
}
