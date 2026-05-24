import { Component, Output, EventEmitter, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UsersService } from '../../core/users.service';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-account-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './account-modal.component.html'
})
export class AccountModalComponent implements OnInit {
  @Output() close = new EventEmitter<void>();

  currentPw = ''; newPw = ''; confirmPw = '';
  pwError = ''; pwSuccess = false;

  totpEnabled = false; totpLoading = true;
  showTotpSetup = false;
  totpQr = ''; totpSecret = ''; totpCode = ''; totpSetupError = '';

  constructor(private usersService: UsersService, private auth: AuthService) {}

  ngOnInit(): void { this.loadTotpStatus(); }

  private loadTotpStatus(): void {
    this.totpLoading = true;
    this.usersService.getMe().subscribe({
      next: d => { this.totpEnabled = d.totp_enabled; this.totpLoading = false; },
      error: () => { this.totpLoading = false; }
    });
  }

  async changePassword(): Promise<void> {
    this.pwError = ''; this.pwSuccess = false;
    if (!this.currentPw || !this.newPw || !this.confirmPw) { this.pwError = 'All fields are required.'; return; }
    if (this.newPw !== this.confirmPw) { this.pwError = 'New passwords do not match.'; return; }
    if (this.newPw.length < 8) { this.pwError = 'Password must be at least 8 characters.'; return; }

    try {
      const [cur, nw] = await Promise.all([this.auth.sha256(this.currentPw), this.auth.sha256(this.newPw)]);
      await this.usersService.changePassword({ currentPasswordHash: cur, newPasswordHash: nw }).toPromise();
      this.currentPw = ''; this.newPw = ''; this.confirmPw = '';
      this.pwSuccess = true;
    } catch (e: unknown) {
      const err = e as { error?: { error?: string } };
      this.pwError = err?.error?.error || 'Failed.';
    }
  }

  startTotpSetup(): void {
    this.usersService.setupTotp().subscribe({
      next: d => { this.totpQr = d.qrDataUrl; this.totpSecret = d.secret; this.totpCode = ''; this.totpSetupError = ''; this.showTotpSetup = true; },
      error: e => alert(e?.error?.error || 'Error.')
    });
  }

  async confirmTotp(): Promise<void> {
    this.totpSetupError = '';
    if (!this.totpCode || this.totpCode.length < 6) { this.totpSetupError = 'Enter the 6-digit code.'; return; }
    try {
      await this.usersService.confirmTotp(this.totpCode).toPromise();
      this.showTotpSetup = false;
      this.loadTotpStatus();
      alert('Two-factor authentication is now enabled!');
    } catch (e: unknown) {
      const err = e as { error?: { error?: string } };
      this.totpSetupError = err?.error?.error || 'Invalid code.';
    }
  }

  disableTotp(): void {
    if (!confirm('Disable two-factor authentication? This will make your account less secure.')) return;
    this.usersService.disableTotp().subscribe({ next: () => this.loadTotpStatus(), error: () => {} });
  }

  dismiss(): void { this.close.emit(); }
}
