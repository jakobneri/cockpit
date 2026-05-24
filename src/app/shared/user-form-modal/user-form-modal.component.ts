import { Component, Input, Output, EventEmitter, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UsersService } from '../../core/users.service';
import { AuthService } from '../../core/auth.service';
import { User } from '../../models/types';

@Component({
  selector: 'app-user-form-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './user-form-modal.component.html'
})
export class UserFormModalComponent implements OnInit {
  @Input() editUser: User | null = null;
  @Output() close = new EventEmitter<void>();

  username = '';
  password = '';
  passwordEdit = '';
  role: 'viewer' | 'operator' | 'admin' = 'viewer';
  error = '';
  loading = false;

  get isEdit(): boolean { return !!this.editUser; }
  get title(): string { return this.isEdit ? 'Edit User' : 'New User'; }

  constructor(private usersService: UsersService, private auth: AuthService) {}

  ngOnInit(): void {
    if (this.editUser) {
      this.username = this.editUser.username;
      this.role = this.editUser.role;
    }
  }

  async submit(): Promise<void> {
    this.error = '';
    if (!this.username.trim()) { this.error = 'Username is required.'; return; }

    this.loading = true;
    try {
      if (this.isEdit) {
        const body: { username: string; role: string; passwordHash?: string } = { username: this.username.trim(), role: this.role };
        if (this.passwordEdit) body.passwordHash = await this.auth.sha256(this.passwordEdit);
        await this.usersService.updateUser(this.editUser!.id, body).toPromise();
      } else {
        if (!this.password) { this.error = 'Password is required.'; this.loading = false; return; }
        if (this.password.length < 8) { this.error = 'Password must be at least 8 characters.'; this.loading = false; return; }
        const passwordHash = await this.auth.sha256(this.password);
        await this.usersService.createUser({ username: this.username.trim(), passwordHash, role: this.role }).toPromise();
      }
      this.close.emit();
    } catch (e: unknown) {
      const err = e as { error?: { error?: string } };
      this.error = err?.error?.error || 'Operation failed.';
    } finally {
      this.loading = false;
    }
  }

  dismiss(): void { this.close.emit(); }
}
