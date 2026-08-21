"use client";

import { Check, ChevronDown, FolderKanban } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui";

export function ProjectPicker({
  projects,
  value,
  onChange,
}: {
  projects: Array<{ id: string; name: string }>;
  value: string;
  onChange: (projectId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selectedProject = projects.find((project) => project.id === value) ?? projects[0];

  useEffect(() => {
    function closeWhenClickingOutside(event: PointerEvent): void {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("pointerdown", closeWhenClickingOutside);
    return () => document.removeEventListener("pointerdown", closeWhenClickingOutside);
  }, []);

  return (
    <div className="project-picker" ref={containerRef}>
      <Button
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="project-picker-trigger"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
        type="button"
      >
        <span className="project-picker-icon" aria-hidden="true">
          <FolderKanban size={16} />
        </span>
        <span>{selectedProject?.name ?? "请选择项目"}</span>
        <ChevronDown
          className={open ? "project-picker-chevron open" : "project-picker-chevron"}
          size={15}
        />
      </Button>
      {open ? (
        <div className="project-picker-options" id={listboxId} role="listbox">
          {projects.map((project) => {
            const selected = project.id === selectedProject?.id;
            return (
              <Button
                aria-selected={selected}
                className="project-picker-option"
                key={project.id}
                onClick={() => {
                  onChange(project.id);
                  setOpen(false);
                }}
                role="option"
                type="button"
              >
                <span>{project.name}</span>
                {selected ? <Check aria-hidden="true" size={15} /> : null}
              </Button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
