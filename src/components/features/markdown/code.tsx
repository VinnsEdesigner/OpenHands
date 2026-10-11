import React from "react";
import { ExtraProps } from "react-markdown";
import { CopyableContentWrapper } from "#/components/shared/buttons/copyable-content-wrapper";
import { useColorTheme } from "#/hooks/use-color-theme";
import { getSyntaxHighlighterTheme } from "#/themes/syntax-highlighter-themes";
import { cn } from "#/utils/utils";
import { SyntaxHighlighter } from "./syntax-highlighter";

// See https://github.com/remarkjs/react-markdown?tab=readme-ov-file#use-custom-components-syntax-highlight

export type CodeProps = React.ClassAttributes<HTMLElement> &
  React.HTMLAttributes<HTMLElement> &
  ExtraProps;

/**
 * Render a fenced code block as a plain, copyable `<pre>` WITHOUT running the
 * syntax highlighter. Used while a message is actively streaming: Prism
 * tokenization is the single most expensive step in the markdown pipeline, and
 * re-running it every animation frame for a growing code block is what makes a
 * fast model's output crawl. The block "snaps" to highlighted once the message
 * settles (see `MarkdownRenderer`'s `disableHighlight` prop).
 */
function PlainCodeBlock({
  codeString,
  className,
}: {
  codeString: string;
  className?: string;
}) {
  return (
    <CopyableContentWrapper text={codeString}>
      <pre className="bg-surface-raised text-foreground border border-surface-raised rounded p-[1em] overflow-auto">
        <code className={className}>{codeString}</code>
      </pre>
    </CopyableContentWrapper>
  );
}

/**
 * Build the `code` component used by react-markdown. When `disableHighlight`
 * is true, fenced code blocks skip Prism entirely (plain `<pre>`); inline and
 * unfenced code render identically in both modes.
 *
 * The returned component is capitalized (`Code`) because it calls a hook
 * (`useColorTheme`), and `react-hooks/rules-of-hooks` only treats capitalized
 * functions as components. The highlighter theme follows the app's
 * light/dark setting.
 */
export function createCodeComponent(disableHighlight = false) {
  return function Code({ children, className }: CodeProps) {
    const colorTheme = useColorTheme();
    const match = /language-(\w+)/.exec(className || ""); // get the language
    const codeString = String(children).replace(/\n$/, "");

    if (!match) {
      const isMultiline = String(children).includes("\n");

      if (!isMultiline) {
        return (
          <code
            className={cn(
              className,
              "bg-surface-raised text-foreground border border-surface-raised rounded px-[0.4em] py-[0.2em]",
            )}
          >
            {children}
          </code>
        );
      }

      return (
        <PlainCodeBlock
          codeString={codeString}
          className={className ?? undefined}
        />
      );
    }

    if (disableHighlight) {
      return (
        <PlainCodeBlock
          codeString={codeString}
          className={className ?? undefined}
        />
      );
    }

    return (
      <CopyableContentWrapper text={codeString}>
        <SyntaxHighlighter
          className="rounded-lg"
          style={getSyntaxHighlighterTheme(colorTheme)}
          language={match?.[1]}
          PreTag="div"
        >
          {codeString}
        </SyntaxHighlighter>
      </CopyableContentWrapper>
    );
  };
}

/**
 * Default `code` component with highlighting enabled. Kept for direct use in
 * tests and any caller that renders code outside `MarkdownRenderer`.
 */
export const code = createCodeComponent(false);
