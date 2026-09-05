import { NextResponse } from "next/server";
import { caseSuiteScheduleSchema } from "@autoforge/contracts";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ suiteId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const { suiteId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_suite.read");
    const suite = await services.caseSuites.getSummary(suiteId, projectIds);
    const schedule = await services.platformOperations.readSuiteSchedule(identity, suite);
    return NextResponse.json(caseSuiteScheduleSchema.nullable().parse(schedule));
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function PUT(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { suiteId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_suite.manage");
    const suite = await services.caseSuites.getSummary(suiteId, projectIds);
    const schedule = await services.platformOperations.upsertSchedule(
      identity,
      suite,
      await readJsonBody(request, 32 * 1024),
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_suite.schedule_update",
      resourceType: "case_suite",
      resourceId: suiteId,
      projectId: suite.projectId,
      requestId: currentRequestId,
      details: { scheduleId: schedule.id, enabled: schedule.enabled },
    });
    return NextResponse.json(schedule);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { suiteId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_suite.manage");
    const suite = await services.caseSuites.getSummary(suiteId, projectIds);
    const schedule = await services.platformOperations.readSuiteSchedule(identity, suite);
    if (schedule) await services.platformOperations.deleteSchedule(identity, schedule);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_suite.schedule_delete",
      resourceType: "case_suite",
      resourceId: suiteId,
      projectId: suite.projectId,
      requestId: currentRequestId,
    });
    return NextResponse.json({ deleted: Boolean(schedule) });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
