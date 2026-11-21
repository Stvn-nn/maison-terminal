import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Compose class names, letting later Tailwind utilities override earlier ones. */
export function cn(...classInputs) {
  return twMerge(clsx(classInputs))
}
