export default function AuthError() {
  return (
    <main className="min-h-dvh flex items-center justify-center p-8">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">Sign-in failed</h1>
        <p className="mt-2 text-neutral-500">Try again from the home page.</p>
        <a href="/" className="mt-4 inline-block underline">Home</a>
      </div>
    </main>
  )
}
