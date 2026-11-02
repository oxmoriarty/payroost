import { NextResponse } from "next/server";

export function apiError(code: string, status = 400, headers?: HeadersInit) {
  return NextResponse.json({ error: code }, { status, headers });
}
