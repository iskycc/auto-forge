import Image from "next/image";

/** The shell, public homepage and browser tab share one offline vector asset. */
export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <Image src="/icon.svg" width={size} height={size} alt="" unoptimized className="shrink-0" />
  );
}
