import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { JwtPayload } from '../models/types';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly JWT_KEY = 'cockpit_jwt';
  private _refreshPromise: Promise<boolean> | null = null;

  constructor(private router: Router) {}

  getToken(): string | null { return localStorage.getItem(this.JWT_KEY); }
  setToken(t: string): void { localStorage.setItem(this.JWT_KEY, t); }
  clearToken(): void { localStorage.removeItem(this.JWT_KEY); }

  parseJwt(token: string): JwtPayload | null {
    try {
      const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(base64)) as JwtPayload;
    } catch { return null; }
  }

  currentUser(): JwtPayload | null {
    const t = this.getToken();
    return t ? this.parseJwt(t) : null;
  }

  isAuthenticated(): boolean {
    const u = this.currentUser();
    return !!(u && u.exp * 1000 > Date.now());
  }

  async sha256(str: string): Promise<string> {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  tryRefresh(): Promise<boolean> {
    if (this._refreshPromise) return this._refreshPromise;
    this._refreshPromise = (async () => {
      try {
        const res = await fetch('/api/auth/refresh', { method: 'POST' });
        if (!res.ok) return false;
        const data = await res.json();
        this.setToken(data.token);
        return true;
      } catch { return false; }
      finally { this._refreshPromise = null; }
    })();
    return this._refreshPromise;
  }

  async logout(): Promise<void> {
    this.clearToken();
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    this.router.navigate(['/login']);
  }
}
