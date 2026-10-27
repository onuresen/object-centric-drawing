// Find an object's other places by its tag text. Pure helpers.
// A hit is only a suggestion. It becomes a mark only when a person links it.

const MAXIMUM_CHIP_LENGTH = 24;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

function multiply(first, second) {
  return [
    first[0] * second[0] + first[2] * second[1],
    first[1] * second[0] + first[3] * second[1],
    first[0] * second[2] + first[2] * second[3],
    first[1] * second[2] + first[3] * second[3],
    first[0] * second[4] + first[2] * second[5] + first[4],
    first[1] * second[4] + first[3] * second[5] + first[5],
  ];
}

// One text item as an origin and two edge vectors in normalized page coordinates.
// `viewport` is a PDF.js viewport at the page's own rotation: { transform, width, height }.
export function indexPlaceTextPage(textContent, viewport, pageNumber) {
  const items = [];
  const width = Number(viewport?.width);
  const height = Number(viewport?.height);
  if (!(width > 0) || !(height > 0) || !Array.isArray(viewport?.transform)) {
    return { pageNumber, items };
  }
  for (const item of textContent?.items ?? []) {
    const text = String(item?.str ?? "");
    if (!text.trim() || !Array.isArray(item.transform)) {
      continue;
    }
    const [a, b, c, d] = item.transform;
    const along = Math.hypot(a, b);
    const up = Math.hypot(c, d);
    const itemWidth = Number(item.width) || 0;
    const itemHeight = Number(item.height) || up;
    if (!(along > 0) || !(up > 0) || !(itemWidth > 0) || !(itemHeight > 0)) {
      continue;
    }
    const device = multiply(viewport.transform, item.transform);
    // Edge vectors in device pixels: the text run and its height.
    const runX = (device[0] / along) * itemWidth;
    const runY = (device[1] / along) * itemWidth;
    const riseX = (device[2] / up) * itemHeight;
    const riseY = (device[3] / up) * itemHeight;
    items.push({
      text,
      origin: { x: device[4] / width, y: device[5] / height },
      run: { x: runX / width, y: runY / height },
      rise: { x: riseX / width, y: riseY / height },
    });
  }
  return { pageNumber, items };
}

// Box of characters [start, end) of one item. A little below the baseline counts too.
export function textRangeBounds(item, start, end) {
  const length = Math.max(item.text.length, 1);
  const corners = [];
  for (const fraction of [start / length, end / length]) {
    for (const lift of [-0.25, 1]) {
      corners.push({
        x: item.origin.x + item.run.x * fraction + item.rise.x * lift,
        y: item.origin.y + item.run.y * fraction + item.rise.y * lift,
      });
    }
  }
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function isWordBoundary(text, index) {
  return index < 0 || index >= text.length || !WORD_CHARACTER.test(text[index]);
}

// Case-insensitive. A whole-word hit by default, so "D1" does not find "D10".
// A hit stays inside one text item; tags are short and rarely split.
export function findPlaceCandidates(pages, query, { documentId = null, wholeWord = true } = {}) {
  const needle = String(query ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
  if (!needle) {
    return [];
  }
  const candidates = [];
  for (const page of pages) {
    for (const item of page.items) {
      const haystack = item.text.toLocaleLowerCase();
      let from = 0;
      while (from <= haystack.length - needle.length) {
        const start = haystack.indexOf(needle, from);
        if (start < 0) {
          break;
        }
        const end = start + needle.length;
        if (!wholeWord || (isWordBoundary(item.text, start - 1) && isWordBoundary(item.text, end))) {
          const bounds = textRangeBounds(item, start, end);
          candidates.push({
            key: placeCandidateKey(documentId, page.pageNumber, bounds),
            documentId,
            page: page.pageNumber,
            bounds,
            text: item.text.trim(),
          });
        }
        from = end;
      }
    }
  }
  return candidates;
}

export function placeCandidateKey(documentId, page, bounds) {
  return `${documentId}:${page}:${bounds.x.toFixed(4)}:${bounds.y.toFixed(4)}`;
}

function center(bounds) {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function containsPoint(bounds, point) {
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}

function occurrenceAt(occurrences, candidate) {
  const point = center(candidate.bounds);
  return occurrences.find((occurrence) => (
    occurrence.documentId === candidate.documentId
    && occurrence.page === candidate.page
    && occurrence.bounds
    && containsPoint(occurrence.bounds, point)
  ));
}

// Drops hits already inside one of this object's marks, and dismissed hits.
// A hit inside another object's mark stays, with that object's ID, so the person can judge it.
export function openPlaceCandidates(candidates, occurrences, objectId, dismissedKeys = new Set()) {
  const own = occurrences.filter((occurrence) => occurrence.objectId === objectId);
  const others = occurrences.filter((occurrence) => occurrence.objectId && occurrence.objectId !== objectId);
  const open = [];
  for (const candidate of candidates) {
    if (dismissedKeys.has(candidate.key) || occurrenceAt(own, candidate)) {
      continue;
    }
    const other = occurrenceAt(others, candidate);
    open.push(other ? { ...candidate, insideObjectId: other.objectId } : { ...candidate });
  }
  return open;
}

// How many pages the hits are on.
export function countPlacePages(candidates) {
  return new Set(candidates.map((candidate) => `${candidate.documentId}:${candidate.page}`)).size;
}

// A comfortable mark around the text, kept on the page.
export function placeMarkBounds(bounds) {
  const pad = Math.max(Math.min(bounds.width, bounds.height) * 0.35, 0.002);
  const x = Math.max(bounds.x - pad, 0);
  const y = Math.max(bounds.y - pad, 0);
  return {
    x,
    y,
    width: Math.min(bounds.x + bounds.width + pad, 1) - x,
    height: Math.min(bounds.y + bounds.height + pad, 1) - y,
  };
}

// Short texts inside the object's marks, offered as one-click queries.
export function textsInsideMarks(pages, occurrences, limit = 4) {
  const found = [];
  const seen = new Set();
  for (const occurrence of occurrences) {
    const page = pages.find((entry) => entry.pageNumber === occurrence.page);
    if (!page || !occurrence.bounds) {
      continue;
    }
    for (const item of page.items) {
      const text = item.text.trim().replace(/\s+/g, " ");
      const key = text.toLocaleLowerCase();
      if (!text || text.length > MAXIMUM_CHIP_LENGTH || seen.has(key)) {
        continue;
      }
      if (containsPoint(occurrence.bounds, center(textRangeBounds(item, 0, item.text.length)))) {
        seen.add(key);
        found.push(text);
        if (found.length >= limit) {
          return found;
        }
      }
    }
  }
  return found;
}
