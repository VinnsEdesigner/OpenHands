import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import {
  code as Code,
  createCodeComponent,
} from "#/components/features/markdown/code";

describe("code (markdown)", () => {
  it("should render inline code without a copy button", () => {
    render(<Code>inline snippet</Code>);

    expect(screen.getByText("inline snippet")).toBeInTheDocument();
    expect(screen.queryByTestId("copy-to-clipboard")).not.toBeInTheDocument();
  });

  it("should render a multiline code block with a copy button", () => {
    render(<Code>{"line1\nline2"}</Code>);

    expect(screen.getByText("line1 line2")).toBeInTheDocument();
    expect(screen.getByTestId("copy-to-clipboard")).toBeInTheDocument();
  });

  it("should render a syntax-highlighted block with a copy button", () => {
    render(<Code className="language-js">{"console.log('hi')"}</Code>);

    expect(screen.getByTestId("copy-to-clipboard")).toBeInTheDocument();
  });

  it("should copy code block content to clipboard", async () => {
    const user = userEvent.setup();
    render(<Code>{"line1\nline2"}</Code>);

    await user.click(screen.getByTestId("copy-to-clipboard"));

    await waitFor(() =>
      expect(navigator.clipboard.readText()).resolves.toBe("line1\nline2"),
    );
  });
});

describe("createCodeComponent (deferred highlighting)", () => {
  it("renders a fenced code block as a plain <pre> when highlighting is disabled", () => {
    const PlainCode = createCodeComponent(true);
    const { container } = render(
      <PlainCode className="language-js">{"console.log('hi')"}</PlainCode>,
    );
    // Plain mode: a <pre><code> pair, no SyntaxHighlighter wrapper.
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.querySelector("code")?.textContent).toBe("console.log('hi')");
  });

  it("still copies the code string in plain mode", async () => {
    const user = userEvent.setup();
    const PlainCode = createCodeComponent(true);
    render(
      <PlainCode className="language-js">{"console.log('hi')"}</PlainCode>,
    );
    await user.click(screen.getByTestId("copy-to-clipboard"));
    await waitFor(() =>
      expect(navigator.clipboard.readText()).resolves.toBe("console.log('hi')"),
    );
  });

  it("highlights fenced code by default (highlighting enabled)", () => {
    const HighlightedCode = createCodeComponent(false);
    const { container } = render(
      <HighlightedCode className="language-js">
        {"console.log('hi')"}
      </HighlightedCode>,
    );
    // Highlighted path renders through SyntaxHighlighter (PreTag="div") which
    // produces a <pre> internally; the code text is present.
    expect(container.textContent).toContain("console.log");
  });

  it("renders inline code identically in both modes", () => {
    const PlainCode = createCodeComponent(true);
    const HighlightedCode = createCodeComponent(false);
    const { container: plain } = render(<PlainCode>{"x"}</PlainCode>);
    const { container: highlighted } = render(
      <HighlightedCode>{"x"}</HighlightedCode>,
    );
    expect(plain.querySelector("code")?.textContent).toBe("x");
    expect(highlighted.querySelector("code")?.textContent).toBe("x");
  });
});
