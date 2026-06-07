export default function ApprovalQueuePage() {
  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <div className="container mx-auto p-4">
        <h1 className="text-2xl font-bold mb-4">Approval Queue</h1>
        <p>This is a placeholder for the approval queue UI.</p>
        <div className="mt-6">
          <button className="px-4 py-2 bg-blue-600 rounded hover:bg-blue-700">
            Approve All
          </button>
          <button className="ml-2 px-4 py-2 bg-red-600 rounded hover:bg-red-700">
            Reject All
          </button>
        </div>
      </div>
    </div>
  );
}