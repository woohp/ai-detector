import type { TranscriptResponse } from './messages';

/**
 * Gets the transcript of the YouTube video playing in this page. Runs in the page itself
 * (scripting.executeScript with world: 'MAIN'), so it must be self-contained: no imports or
 * module-level helpers.
 *
 * Caption URLs need a token that only YouTube's player can mint, so we don't fetch captions
 * ourselves. Instead we briefly hook fetch/XHR, switch captions off and on so the player fetches
 * the track again, and read its response. The caption setting is restored afterwards.
 */
export async function grabTranscript(): Promise<TranscriptResponse> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function waitFor<T>(get: () => T | undefined | false, ms: number): Promise<T | undefined> {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
      const value = get();
      if (value) return value;
    }
    return undefined;
  }

  interface Track {
    languageCode: string;
    kind?: string;
  }
  const player = document.querySelector('#movie_player') as
    | (HTMLElement & {
        getPlayerResponse?: () => any;
        getOption?: (module: string, key: string) => any;
        setOption?: (module: string, key: string, value: unknown) => void;
      })
    | null;
  const response = player?.getPlayerResponse?.();
  if (!player || !response?.videoDetails) return { ok: false, error: 'No video found on this page' };

  const tracks: Track[] = response.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const english = tracks.filter((t) => t.languageCode?.startsWith('en'));
  if (!english.length) {
    return { ok: false, error: tracks.length ? 'This video has no English captions' : 'This video has no captions' };
  }
  // Creator-uploaded captions are usually the script itself; auto-generated ones are speech recognition.
  const wanted = english.find((t) => t.kind !== 'asr') ?? english[0]!;

  if (!(await waitFor(() => !player.classList.contains('ad-showing'), 120_000))) {
    return { ok: false, error: 'An ad is still playing; try again when it ends' };
  }
  const button = document.querySelector<HTMLElement>('.ytp-subtitles-button');
  if (!button) return { ok: false, error: 'Could not find the captions button' };
  const captionsOn = () => button.getAttribute('aria-pressed') === 'true';
  const wasOn = captionsOn();

  const captured: { url: string; text: string }[] = [];
  const isCaptions = (url: string) => url.includes('/api/timedtext');
  const keep = (url: string, text: string) => text && captured.push({ url, text });
  const fetch0 = window.fetch;
  const open0 = XMLHttpRequest.prototype.open;
  const send0 = XMLHttpRequest.prototype.send;
  window.fetch = async function (input, init) {
    const res = await fetch0.call(this, input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (isCaptions(url)) res.clone().text().then((t) => keep(url, t), () => {});
    return res;
  };
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest & { _url?: string }, ...args: any[]) {
    this._url = String(args[1]);
    return (open0 as any).apply(this, args);
  };
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest & { _url?: string }, body) {
    if (this._url && isCaptions(this._url)) {
      this.addEventListener('load', () => keep(this._url!, typeof this.response === 'string' ? this.response : ''));
    }
    return send0.call(this, body);
  };

  const trackOf = (url: string) => {
    const params = new URL(url, location.href).searchParams;
    return { lang: params.get('lang') ?? '', asr: params.get('kind') === 'asr', translated: params.has('tlang') };
  };
  const matches = (url: string) => {
    const t = trackOf(url);
    return t.lang === wanted.languageCode && t.asr === (wanted.kind === 'asr') && !t.translated;
  };
  const next = (from: number, ms = 8000) => waitFor(() => captured.slice(from).at(-1), ms);

  try {
    let hit: { url: string; text: string } | undefined;
    for (let attempt = 0; attempt < 2 && !hit; attempt++) {
      const from = captured.length;
      if (captionsOn()) {
        button.click();
        await sleep(300);
      }
      button.click(); // captions on: the player fetches the track it shows
      hit = await next(from);
    }
    if (!hit) return { ok: false, error: 'Captions did not load; try again' };

    // The player picks a track from the viewer's settings; switch if it isn't the one we want.
    if (!matches(hit.url)) {
      const list: Track[] = player.getOption?.('captions', 'tracklist') ?? [];
      const track = list.find((t) => t.languageCode === wanted.languageCode && (t.kind === 'asr') === (wanted.kind === 'asr'));
      if (track) {
        const from = captured.length;
        player.setOption?.('captions', 'track', track);
        hit = (await next(from)) ?? hit;
      }
    }
    const { lang, asr } = trackOf(hit.url);
    if (!lang.startsWith('en')) return { ok: false, error: 'Could not load the English captions' };

    let lines: { ms: number; text: string }[];
    if (hit.text.trimStart().startsWith('{')) {
      const events: { tStartMs?: number; segs?: { utf8: string }[] }[] = JSON.parse(hit.text).events ?? [];
      lines = events.filter((e) => e.segs).map((e) => ({ ms: e.tStartMs ?? 0, text: e.segs!.map((s) => s.utf8).join('') }));
    } else {
      // XML formats: <p t="ms">…</p> (srv3) or <text start="s">…</text>.
      const doc = new DOMParser().parseFromString(hit.text, 'text/xml');
      lines = [...doc.querySelectorAll('p, text')].map((n) => ({
        ms: n.hasAttribute('t') ? Number(n.getAttribute('t')) : Number(n.getAttribute('start')) * 1000,
        text: n.textContent ?? '',
      }));
    }
    const segments = lines
      .map((l) => ({ ms: l.ms, text: l.text.replace(/\[[^\]]*\]|\([^)]*\)|♪|>>/g, ' ').replace(/\s+/g, ' ').trim() }))
      .filter((s) => s.text);
    if (!segments.length) return { ok: false, error: 'The captions were empty' };

    return {
      ok: true,
      videoId: response.videoDetails.videoId,
      title: response.videoDetails.title,
      durationMs: Number(response.videoDetails.lengthSeconds) * 1000,
      autoCaptions: asr,
      segments,
    };
  } finally {
    window.fetch = fetch0;
    XMLHttpRequest.prototype.open = open0;
    XMLHttpRequest.prototype.send = send0;
    if (captionsOn() !== wasOn) button.click();
  }
}
