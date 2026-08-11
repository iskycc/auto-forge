import { ChevronDown } from "lucide-react";
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

type ButtonVariant = "neutral" | "primary" | "secondary" | "danger" | "ghost";
type ButtonSize = "compact" | "regular" | "large";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "neutral", size = "regular", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={classes("ui-button", `ui-button-${variant}`, `ui-button-${size}`, className)}
      {...props}
    />
  );
});

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={classes("ui-input", className)} {...props} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={classes("ui-textarea", className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, disabled, ...props }, ref) {
    return (
      <span
        className="ui-select"
        data-disabled={disabled ? "true" : undefined}
        data-multiple={props.multiple ? "true" : undefined}
      >
        <select
          ref={ref}
          className={classes("ui-select-control", className)}
          disabled={disabled}
          {...props}
        >
          {children}
        </select>
        <ChevronDown aria-hidden="true" className="ui-select-icon" size={15} strokeWidth={2.2} />
      </span>
    );
  },
);

function classes(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}
