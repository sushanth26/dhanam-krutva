export function pageFromLocationHash(hash) {
  if (hash === "#mtfs") return "mtfs";
  return "home";
}

export function hashForPage(page) {
  if (page === "mtfs") return "#mtfs";
  return "";
}
