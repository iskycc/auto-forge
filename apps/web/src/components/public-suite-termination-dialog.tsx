"use client";

import { Alert, Form, Input } from "antd";
import { useState } from "react";
import {
  PUBLIC_SUITE_NO_ENVIRONMENT_CONFIRMATION,
  type PublicSuiteBatch,
  type PublicSuiteTerminationConfirmation,
} from "@autoforge/contracts";
import { sameEnvironmentAddresses } from "@autoforge/domain";
import { ActionDialog } from "./action-dialog";
import { Button } from "./ui/button";

export function PublicSuiteTerminationDialog({
  batch,
  currentUserId,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  batch: PublicSuiteBatch;
  currentUserId: string | null;
  pending: boolean;
  error: string;
  onClose: () => void;
  onConfirm: (confirmation?: PublicSuiteTerminationConfirmation) => void;
}) {
  const [username, setUsername] = useState("");
  const [addresses, setAddresses] = useState(() => batch.environmentAddresses.map(() => ""));
  const [emptyConfirmation, setEmptyConfirmation] = useState("");
  const ownExecution = !!currentUserId && currentUserId === batch.initiator?.id;
  const confirmation: PublicSuiteTerminationConfirmation = {
    initiatorUsername: username.trim(),
    environmentAddresses: addresses.map((address) => address.trim()),
    ...(batch.environmentAddresses.length === 0
      ? { noEnvironmentConfirmation: emptyConfirmation.trim() }
      : {}),
  };
  const ready =
    ownExecution ||
    (!!batch.initiator &&
      confirmation.initiatorUsername === batch.initiator.username &&
      sameEnvironmentAddresses(confirmation.environmentAddresses, batch.environmentAddresses) &&
      (batch.environmentAddresses.length > 0 ||
        confirmation.noEnvironmentConfirmation === PUBLIC_SUITE_NO_ENVIRONMENT_CONFIRMATION));

  return (
    <ActionDialog
      open
      title="终止任务执行"
      onClose={onClose}
      closeDisabled={pending}
      className="w-[min(560px,calc(100dvw-3rem))]"
      footer={
        <>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            返回
          </Button>
          <Button
            type="button"
            variant="destructive"
            loading={pending}
            disabled={pending || !ready}
            onClick={() => onConfirm(ownExecution ? undefined : confirmation)}
          >
            确认终止
          </Button>
        </>
      }
    >
      <div className="grid min-w-0 gap-4">
        <Alert
          type="warning"
          showIcon
          title={`确定终止批次 #${batch.sequenceNumber}？`}
          description="停止后续派发和重跑；已领取的用例会按现有平滑终止规则完成并上传。终止不一定立即结束，操作人会写入执行记录。"
        />
        {!ownExecution ? (
          <>
            <Alert
              type="info"
              showIcon
              title="您不是此批次的拉起人"
              description={`拉起人：${batch.initiator?.username ?? batch.requestedBy ?? "未知"}。请手动填写账号与本批次的全部环境 IP，核对后再终止。`}
            />
            <Form layout="vertical" component="div" className="min-w-0">
              <Form.Item
                label="拉起人账号"
                required
                validateStatus={
                  username && username.trim() !== batch.initiator?.username ? "error" : ""
                }
                help={
                  username && username.trim() !== batch.initiator?.username
                    ? "账号与本批次拉起人不一致。"
                    : undefined
                }
              >
                <Input
                  aria-label="拉起人账号"
                  value={username}
                  maxLength={256}
                  autoComplete="off"
                  disabled={pending}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </Form.Item>
              {addresses.length > 0 ? (
                addresses.map((address, index) => (
                  <Form.Item key={index} label={`本批次环境 IP ${index + 1}`} required>
                    <Input
                      aria-label={`本批次环境 IP ${index + 1}`}
                      value={address}
                      maxLength={2048}
                      autoComplete="off"
                      disabled={pending}
                      placeholder="手动输入此批次实际使用的环境 IP"
                      onChange={(event) =>
                        setAddresses((current) =>
                          current.map((value, row) => (row === index ? event.target.value : value)),
                        )
                      }
                    />
                  </Form.Item>
                ))
              ) : (
                <Form.Item label="环境 IP 确认" required>
                  <Input
                    aria-label="环境 IP 确认"
                    value={emptyConfirmation}
                    maxLength={64}
                    autoComplete="off"
                    disabled={pending}
                    placeholder={`请输入“${PUBLIC_SUITE_NO_ENVIRONMENT_CONFIRMATION}”`}
                    onChange={(event) => setEmptyConfirmation(event.target.value)}
                  />
                </Form.Item>
              )}
              <p className="m-0 text-xs leading-5 text-muted-foreground">
                多 IP
                必须完整填写，顺序不限；请使用当前批次的执行环境，不要填写任务默认配置或后续执行的
                IP。
              </p>
            </Form>
          </>
        ) : null}
        {!ownExecution &&
        addresses.length > 0 &&
        addresses.every((address) => address.trim()) &&
        !sameEnvironmentAddresses(addresses, batch.environmentAddresses) ? (
          <Alert type="warning" showIcon title="环境 IP 与本批次不一致，请核对全部地址。" />
        ) : null}
        {error ? <Alert type="error" showIcon title={error} /> : null}
      </div>
    </ActionDialog>
  );
}
