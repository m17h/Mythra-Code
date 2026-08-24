import { memo } from "react";

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/**
 * Rolling-digit readout. Each digit renders as a vertical reel of 0–9 that
 * slides to the current value, so live numbers (context %, cost) tick over
 * like an odometer instead of jumping. Non-digit characters render inline as
 * plain text. Screen readers get the flat value once via aria-label.
 */
export const Odometer = memo(function Odometer({ value, label }: { value: string; label?: string }) {
  return (
    <span className="odometer" role="text" aria-label={label ?? value}>
      {[...value].map((char, index) => (
        DIGITS.includes(char)
          ? (
            <span className="odometer-reel" key={index} aria-hidden="true">
              <span style={{ transform: `translateY(-${Number(char) * 10}%)` }}>
                {DIGITS.map((digit) => <i key={digit}>{digit}</i>)}
              </span>
            </span>
          )
          : <span className="odometer-static" key={index} aria-hidden="true">{char}</span>
      ))}
    </span>
  );
});
