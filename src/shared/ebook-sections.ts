// Runs in the browser. Keep whole top-level blocks intact (especially code,
// tables and figures), and resolve anchors before separating the print page.
export function sectionBook(
  html: string,
): Array<{ name: string; html: string }> {
  const document = new DOMParser().parseFromString(html, "text/html");
  const sections: HTMLElement[] = [];
  let section = document.createElement("div");
  let size = 0;
  const encoder = new TextEncoder();
  for (const node of Array.from(document.body.childNodes)) {
    const markup =
      node instanceof Element ? node.outerHTML : (node.textContent ?? "");
    const bytes = encoder.encode(markup).length;
    const heading = node instanceof Element && node.matches("h1");
    if (size && ((heading && size >= 32 * 1024) || size + bytes > 128 * 1024)) {
      sections.push(section);
      section = document.createElement("div");
      size = 0;
    }
    section.append(node);
    size += bytes;
  }
  if (section.childNodes.length) sections.push(section);
  const names = sections.map(
    (_, index) => `part-${String(index).padStart(4, "0")}.html`,
  );
  const anchors = new Map<string, string>();
  sections.forEach((part, index) => {
    part.querySelectorAll("[id],a[name]").forEach((element) => {
      for (const id of [element.id, element.getAttribute("name")]) {
        // Preserve the original document's first-match behavior for duplicate IDs.
        if (id && !anchors.has(id)) anchors.set(id, names[index]);
      }
    });
  });
  return sections.map((part, index) => {
    part.querySelectorAll('a[href^="#"]').forEach((link) => {
      const href = link.getAttribute("href")!;
      let id: string;
      try {
        id = decodeURIComponent(href.slice(1));
      } catch {
        id = href.slice(1);
      }
      const target = anchors.get(id);
      if (target) link.setAttribute("href", `${target}${href}`);
      else if (id) throw new Error(`Unresolved section anchor: ${href}`);
    });
    return { name: names[index], html: part.innerHTML };
  });
}
