import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, RefreshCw, Send } from "lucide-react";
import type { PullRequest } from "../../lib/pullRequests";
import type { RemotePullRequests } from "../../lib/remote/remotePullRequests";
import type { WireCiStatus, WirePullRequestComment } from "../../lib/remote/wire-studio";

const FINISHED_WELL = new Set(["SUCCESS", "PASS", "NEUTRAL", "SKIPPED"]);
const FAILED = new Set(["FAILURE", "FAIL", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]);
function checksSummary(status: WireCiStatus | null): string {
  if (!status) return "";
  if (!status.checks.length) return "No checks on this pull request.";
  const states = status.checks.map((check) => check.state.toUpperCase());
  const passed = states.filter((state) => FINISHED_WELL.has(state)).length, failed = states.filter((state) => FAILED.has(state)).length;
  const running = states.length - passed - failed;
  return [passed && `${passed} passed`, failed && `${failed} failed`, running && `${running} running`].filter(Boolean).join(", ");
}

/** Comments and checks for the attached pull request, read through the machine that owns it. */
export function RemotePullRequestActivity({ pullRequests, pullRequest, allowed, reason, name }: {
  pullRequests: RemotePullRequests; pullRequest: Pick<PullRequest, "repository" | "number">; allowed: boolean; reason: string; name: string;
}) {
  const { repository, number } = pullRequest;
  const [comments, setComments] = useState<WirePullRequestComment[]>([]);
  const [more, setMore] = useState(false);
  const [status, setStatus] = useState<WireCiStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const refresh = useCallback(() => {
    let current = true;
    setLoading(true);
    void Promise.allSettled([pullRequests.comments(number), pullRequests.ci(number)]).then(([list, checks]) => {
      if (!current) return;
      setLoading(false);
      if (list.status === "fulfilled") { setComments(Array.isArray(list.value?.comments) ? list.value.comments : []); setMore(list.value?.hasMore === true); }
      if (checks.status === "fulfilled") setStatus(checks.value);
      setNotice(list.status === "rejected" ? `Comments from ${name} aren't available right now.` : "");
    });
    return () => { current = false; };
  }, [name, number, pullRequests]);
  useEffect(() => refresh(), [refresh]);
  const send = () => {
    const body = draft.trim();
    if (!body || sending) return;
    if (!allowed) { setNotice(reason); return; }
    setSending(true);
    setNotice("");
    // The text stays until the comment is confirmed, because a lost reply may mean it never arrived.
    pullRequests.comment(repository, number, body).then(() => { setDraft(""); refresh(); }, (failure: Error) => setNotice(failure.message)).finally(() => setSending(false));
  };
  const summary = checksSummary(status);
  return <section className="remote-pr-activity" aria-label={`Comments and checks for pull request ${number}`}>
    <header>
      <strong>Comments and checks</strong>
      <button type="button" className="icon-button subtle" aria-label="Refresh comments and checks" title="Refresh" disabled={loading} onClick={refresh}>
        {loading ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
      </button>
    </header>
    {summary && <p className="remote-pr-checks">Checks: {summary}</p>}
    {comments.length > 0 && <ol className="remote-pr-comments">
      {comments.map((comment) => <li key={comment.id}><small>{comment.author}{comment.createdAt ? ` · ${new Date(comment.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}` : ""}</small><p>{comment.body}</p></li>)}
    </ol>}
    {more && <p className="remote-pr-checks">Showing the first {comments.length} comments.</p>}
    <div className="remote-pr-compose">
      <textarea aria-label="Add a comment" placeholder="Add a comment" value={draft} rows={2} maxLength={65536} disabled={sending} onChange={(event) => setDraft(event.target.value)} />
      <button type="button" className="secondary-button" disabled={sending || !draft.trim()} onClick={send}>
        {sending ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <Send size={13} aria-hidden="true" />} Comment
      </button>
    </div>
    {notice && <p className="remote-pr-checks" role="status">{notice}</p>}
  </section>;
}
