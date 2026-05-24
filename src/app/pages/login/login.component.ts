import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';

type LoginStep = 'username' | 'totp' | 'password';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.component.html'
})
export class LoginComponent implements OnInit {
  step: LoginStep = 'username';
  username = '';
  totpCode = '';
  password = '';
  error = '';
  loading = false;

  constructor(private auth: AuthService, private router: Router) {}

  ngOnInit(): void {
    if (this.auth.isAuthenticated()) this.router.navigate(['/']);
  }

  async submitUsername(): Promise<void> {
    this.error = '';
    if (!this.username.trim()) { this.error = 'Please enter your username.'; return; }
    this.loading = true;
    try {
      const res = await fetch('/api/auth/login-method', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: this.username.trim() })
      });
      const data = await res.json();
      this.step = data.method === 'totp' ? 'totp' : 'password';
    } catch {
      this.error = 'Network error — is the hub reachable?';
    } finally {
      this.loading = false;
    }
  }

  async submitTotp(): Promise<void> {
    this.error = '';
    const code = this.totpCode.replace(/\s/g, '');
    if (!code || code.length < 6) { this.error = 'Enter the 6-digit code.'; return; }
    this.loading = true;
    try {
      const res = await fetch('/api/auth/login-totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: this.username, code })
      });
      const data = await res.json();
      if (!res.ok) { this.totpCode = ''; this.error = data.error || 'Invalid code.'; return; }
      this.auth.setToken(data.token);
      this.router.navigate(['/']);
    } catch {
      this.error = 'Network error.';
    } finally {
      this.loading = false;
    }
  }

  async submitPassword(): Promise<void> {
    this.error = '';
    if (!this.password) { this.error = 'Please enter your password.'; return; }
    this.loading = true;
    try {
      const passwordHash = await this.auth.sha256(this.password);
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: this.username, passwordHash })
      });
      const data = await res.json();
      if (!res.ok) { this.error = data.error || 'Login failed.'; return; }
      this.auth.setToken(data.token);
      this.password = '';
      this.router.navigate(['/']);
    } catch {
      this.error = 'Network error — is the hub reachable?';
    } finally {
      this.loading = false;
    }
  }

  onTotpInput(): void {
    if (this.totpCode.replace(/\D/g, '').length === 6) this.submitTotp();
  }

  usePassword(): void { this.step = 'password'; this.error = ''; }
  back(): void { this.step = 'username'; this.error = ''; }
}
