import test from "node:test";
import assert from "node:assert/strict";
import {
  countPlacePages,
  findPlaceCandidates,
  indexPlaceTextPage,
  openPlaceCandidates,
  placeMarkBounds,
  textRangeBounds,
  textsInsideMarks,
} from "../place-finder.mjs";

// A 600 × 800 pt page at scale 1, as PDF.js builds it.
const uprightViewport = { transform: [1, 0, 0, -1, 0, 800], width: 600, height: 800 };
const turnedViewport = { transform: [0, 1, 1, 0, 0, 0], width: 800, height: 600 };

function textItem(str, x, y, { size = 10, width = str.length * size } = {}) {
  return { str, transform: [size, 0, 0, size, x, y], width, height: size };
}

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
}

test("text items index as normalized boxes on an upright page", () => {
  const page = indexPlaceTextPage({ items: [textItem("D03", 100, 700)] }, uprightViewport, 4);
  assert.equal(page.pageNumber, 4);
  assert.equal(page.items.length, 1);
  const bounds = textRangeBounds(page.items[0], 0, 3);
  close(bounds.x, 100 / 600);
  close(bounds.width, 30 / 600);
  close(bounds.y, 90 / 800);
  close(bounds.height, 12.5 / 800);
});

test("a page with its own rotation keeps the box on the page", () => {
  const page = indexPlaceTextPage({ items: [textItem("D03", 100, 700)] }, turnedViewport, 1);
  const bounds = textRangeBounds(page.items[0], 0, 3);
  close(bounds.x, 697.5 / 800);
  close(bounds.y, 100 / 600);
  close(bounds.height, 30 / 600);
  assert.ok(bounds.x + bounds.width <= 1);
});

test("empty and unusable text items are skipped", () => {
  const page = indexPlaceTextPage({
    items: [
      textItem("  ", 10, 10),
      { str: "no transform", width: 10, height: 10 },
      textItem("zero", 10, 10, { width: 0 }),
      { type: "beginMarkedContent" },
    ],
  }, uprightViewport, 1);
  assert.deepEqual(page.items, []);
  assert.deepEqual(indexPlaceTextPage({ items: [textItem("x", 1, 1)] }, null, 1).items, []);
});

test("search is whole-word and case-insensitive by default", () => {
  const pages = [
    indexPlaceTextPage({ items: [textItem("D1", 10, 700), textItem("D10", 100, 700), textItem("door d1", 200, 700)] }, uprightViewport, 1),
    indexPlaceTextPage({ items: [textItem("XD1", 10, 700), textItem("(D1)", 100, 700)] }, uprightViewport, 2),
  ];
  const hits = findPlaceCandidates(pages, " d1 ", { documentId: "document-001" });
  assert.deepEqual(hits.map((hit) => [hit.page, hit.text]), [[1, "D1"], [1, "door d1"], [2, "(D1)"]]);
  assert.ok(hits.every((hit) => hit.documentId === "document-001"));
  assert.equal(new Set(hits.map((hit) => hit.key)).size, 3);

  const partial = findPlaceCandidates(pages, "d1", { wholeWord: false });
  assert.equal(partial.length, 5);
  assert.deepEqual(findPlaceCandidates(pages, "   "), []);
});

test("a hit inside a long item is boxed around the tag only", () => {
  const pages = [indexPlaceTextPage({ items: [textItem("SEE D03 FOR", 0, 700)] }, uprightViewport, 1)];
  const [hit] = findPlaceCandidates(pages, "D03");
  close(hit.bounds.x, 40 / 600);
  close(hit.bounds.width, 30 / 600);
});

test("hits inside the object's own marks or dismissed are dropped; others are flagged", () => {
  const pages = [indexPlaceTextPage({
    items: [textItem("D03", 100, 700), textItem("D03", 300, 700), textItem("D03", 400, 500)],
  }, uprightViewport, 1)];
  const hits = findPlaceCandidates(pages, "D03", { documentId: "document-001" });
  const occurrences = [
    { id: "occurrence-001", objectId: "object-001", documentId: "document-001", page: 1, bounds: { x: 0.1, y: 0.05, width: 0.15, height: 0.1 } },
    { id: "occurrence-002", objectId: "object-002", documentId: "document-001", page: 1, bounds: { x: 0.45, y: 0.05, width: 0.15, height: 0.1 } },
    // Same place, other PDF: does not cover the hit.
    { id: "occurrence-003", objectId: "object-001", documentId: "document-002", page: 1, bounds: { x: 0, y: 0, width: 1, height: 1 } },
  ];
  const open = openPlaceCandidates(hits, occurrences, "object-001", new Set([hits[2].key]));
  assert.equal(open.length, 1);
  assert.equal(open[0].insideObjectId, "object-002");
  assert.equal(hits[1].insideObjectId, undefined, "the input is not changed");
  assert.equal(countPlacePages(hits), 1);
});

test("a mark around a hit is padded and kept on the page", () => {
  const bounds = placeMarkBounds({ x: 0.99, y: 0.001, width: 0.008, height: 0.004 });
  assert.ok(bounds.x >= 0 && bounds.y >= 0);
  assert.ok(bounds.x + bounds.width <= 1 && bounds.y + bounds.height <= 1);
  assert.ok(bounds.x < 0.99 && bounds.y === 0);
});

test("short texts inside the object's marks are offered once each", () => {
  const pages = [indexPlaceTextPage({
    items: [
      textItem("D03", 100, 700),
      textItem("d03", 110, 690),
      textItem("A very long note that is not a tag at all", 100, 680, { size: 2 }),
      textItem("W12", 500, 100),
    ],
  }, uprightViewport, 2)];
  const occurrences = [{ objectId: "object-001", documentId: "document-001", page: 2, bounds: { x: 0.1, y: 0.05, width: 0.2, height: 0.1 } }];
  assert.deepEqual(textsInsideMarks(pages, occurrences), ["D03"]);
  assert.deepEqual(textsInsideMarks(pages, [{ ...occurrences[0], page: 3 }]), []);
});
