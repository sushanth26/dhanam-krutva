export function pageFromLocationHash(hash) {
  if (hash === "#mtfs") return "mtfs";
  if (hash === "#trades") return "trades";
  return "home";
}

export function hashForPage(page) {
  if (page === "mtfs") return "#mtfs";
  if (page === "trades") return "#trades";
  return "";
}
