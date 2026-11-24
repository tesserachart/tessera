export function Refused({ text }: { text: string | null }) {
  return text ? (
    <span className="pz-refused" role="alert" title={text}>
      {text}
    </span>
  ) : null;
}
