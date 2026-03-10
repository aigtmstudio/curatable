import { SignOutButton } from '@clerk/nextjs';

export default function UnauthorizedPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center space-y-4 max-w-md">
        <h1 className="text-2xl font-bold">Access Denied</h1>
        <p className="text-muted-foreground">
          Your account is not authorized to access this application. Contact an
          administrator if you believe this is an error.
        </p>
        <SignOutButton>
          <button className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            Sign out
          </button>
        </SignOutButton>
      </div>
    </div>
  );
}
