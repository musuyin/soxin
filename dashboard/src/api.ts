export class ApiError extends Error {
  status: number
  issues: Record<string, string>

  constructor(status: number, error: string, issues: { path: string, message: string }[] = []) {
    super(error)
    this.status = status
    this.issues = Object.fromEntries(issues.map(issue => [issue.path, issue.message]))
  }
}

export async function request<T>(path: string, options?: { method: string, data: unknown }): Promise<T> {
  let response
  try {
    response = await fetch('/api/' + path, options && {
      method: options.method, body: JSON.stringify(options.data), headers: { 'Content-Type': 'application/json' },
    })
  } catch {
    throw new ApiError(0, 'Could not reach SoXin. Check that the service is running.')
  }
  const result = await response.json()
  if (!response.ok) throw new ApiError(response.status, result.error, result.issues)
  return result
}
