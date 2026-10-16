import { forwardRef, startTransition, useLayoutEffect, useRef, useState, type InputHTMLAttributes } from "react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onChange"> & {
  value: string;
  /** Receives each edit inside a transition, so typing never waits for it. */
  onValueChange: (value: string) => void;
};

/**
 * A text field whose characters update immediately while its owner (the app
 * shell, whose render covers the whole window) catches up in a transition.
 * React may then skip intermediate owner renders while someone types quickly.
 * Changes the owner makes itself, such as clearing a search, still show.
 */
export const TransitionInput = forwardRef<HTMLInputElement, Props>(function TransitionInput({ value, onValueChange, ...props }, ref) {
  const [text, setText] = useState(value);
  // Edits sent but not yet seen back from the owner, oldest first.
  const pending = useRef<string[]>([]);
  useLayoutEffect(() => {
    const echo = pending.current.lastIndexOf(value);
    if (echo >= 0) {
      pending.current.splice(0, echo + 1);
      return;
    }
    pending.current = [];
    setText(value);
  }, [value]);
  return <input
    {...props}
    ref={ref}
    value={text}
    onChange={(event) => {
      const next = event.target.value;
      setText(next);
      pending.current.push(next);
      startTransition(() => onValueChange(next));
    }}
  />;
});
