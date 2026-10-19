/**
 * Which paths on this site are pages, as opposed to endpoints.
 *
 * The API map learns from traffic the site makes on its own, and it cannot tell
 * a document from an API by looking at the URL: a docs site serves
 * `/docs/en/api/overview` as HTML, and no amount of pattern matching separates
 * that from a route. What settles it is that somebody navigated there — which
 * only this process knows.
 *
 * It was two loose variables and a rule spread across two functions, and the
 * rule was wrong. The dispatcher added the landing path, then the miner cleared
 * the set because the site had changed — in that order — so the one path a
 * navigation had just proved was a page was the one path the map never heard
 * about. Every site's landing page, on every first visit.
 *
 * Here the ordering is the class's business and the invariant holds by
 * construction: after `saw`, that path is in the set. There is nothing a caller
 * can do to get it wrong.
 */
export class PagesSeen {
  private _domain = '';
  private readonly _paths = new Set<string>();

  /** The site these paths belong to. Empty until the first navigation. */
  get domain(): string {
    return this._domain;
  }

  get paths(): ReadonlySet<string> {
    return this._paths;
  }

  /**
   * Records a navigation, and answers whether it left the previous site —
   * which is what the caller needs in order to flush and re-arm.
   */
  saw(domain: string, path: string): boolean {
    const moved = domain !== this._domain;
    if (moved) {
      // Paths from the site just left say nothing about this one.
      this._paths.clear();
      this._domain = domain;
    }
    this._paths.add(path);
    return moved;
  }
}
