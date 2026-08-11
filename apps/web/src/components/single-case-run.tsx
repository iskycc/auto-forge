"use client";

import { Button, Input, Select, Textarea } from "@/components/ui";

import type { RunBatchDetails, Runner } from "@autoforge/domain";
import { LoaderCircle, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export function SingleCaseRun({
  caseDefinitionId,
  runners,
}: {
  caseDefinitionId: string;
  runners: Runner[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/case-definitions/${encodeURIComponent(caseDefinitionId)}/execute`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            runnerIds: form.getAll("runnerIds"),
            retryLimit: Number(form.get("retryLimit")),
            executionTimeoutMs: Number(form.get("executionTimeoutMinutes")) * 60_000,
            environmentVariables: [],
            parameters: parseParameters(String(form.get("parameters") ?? "")),
            artifactPatterns: ["reports/testng/**"],
          }),
        },
      );
      const body = (await response.json()) as RunBatchDetails & { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "单用例执行创建失败。");
      router.push(`/run-batches/${encodeURIComponent(body.id)}`);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "单用例执行创建失败。");
      setPending(false);
    }
  }

  return (
    <form className="single-case-run" onSubmit={(event) => void submit(event)}>
      <div>
        <span className="eyebrow">Quick Run</span>
        <h2>单用例执行</h2>
        <p>与批跑共享相同的预检、调度、lease、日志、产物和重试路径。</p>
      </div>
      <label>
        Runner（可多选）
        <Select multiple name="runnerIds" required size={Math.min(5, Math.max(2, runners.length))}>
          {runners.map((runner) => (
            <option disabled={runner.state !== "online"} key={runner.id} value={runner.id}>
              {runner.name} · {runner.state} · {runner.agentVersion}
            </option>
          ))}
        </Select>
      </label>
      <label>
        失败重试
        <Input defaultValue={0} max={10} min={0} name="retryLimit" type="number" />
      </label>
      <label>
        执行超时（分钟）
        <Input defaultValue={60} max={1440} min={1} name="executionTimeoutMinutes" type="number" />
      </label>
      <label className="single-run-parameters">
        参数覆盖（每行 KEY=VALUE）
        <Textarea name="parameters" rows={3} />
      </label>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <Button
        className="button button-primary"
        disabled={pending || runners.every((runner) => runner.state !== "online")}
        type="submit"
      >
        {pending ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />} 立即执行
      </Button>
    </form>
  );
}

function parseParameters(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const separator = line.indexOf("=");
        return separator > 0
          ? [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()]]
          : [];
      }),
  );
}
