import { parseBlocks } from "@/lib/markdown.js";

function renderInline(segments: { text: string; bold: boolean; italic: boolean }[]) {
  return segments.map((seg, i) => {
    if (seg.bold) return <strong key={i}>{seg.text}</strong>;
    if (seg.italic) return <em key={i}>{seg.text}</em>;
    return <span key={i}>{seg.text}</span>;
  });
}

/** Light markdown answer body (paragraphs, lists, bold). */
export function AnswerBody({ text }: { text: string }) {
  return (
    <div className="answer">
      {parseBlocks(text).map((block, i) => {
        if (block.type === "ol") {
          return (
            <ol key={i}>
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item)}</li>
              ))}
            </ol>
          );
        }
        if (block.type === "ul") {
          return (
            <ul key={i}>
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === "h") {
          return <h4 key={i}>{renderInline(block.segments)}</h4>;
        }
        return <p key={i}>{renderInline(block.segments)}</p>;
      })}
    </div>
  );
}
