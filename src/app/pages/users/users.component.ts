import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UsersService } from '../../core/users.service';
import { AuthService } from '../../core/auth.service';
import { User } from '../../models/types';
import { UserFormModalComponent } from '../../shared/user-form-modal/user-form-modal.component';

@Component({
  selector: 'app-users',
  standalone: true,
  imports: [CommonModule, FormsModule, UserFormModalComponent],
  templateUrl: './users.component.html'
})
export class UsersComponent implements OnInit {
  users: User[] = [];
  loading = true;
  error = '';
  selfId: string | number | null = null;

  showUserModal = false;
  editUser: User | null = null;

  constructor(private usersService: UsersService, public auth: AuthService) {}

  ngOnInit(): void {
    this.selfId = this.auth.currentUser()?.sub ?? null;
    this.loadUsers();
  }

  loadUsers(): void {
    this.loading = true;
    this.usersService.getUsers().subscribe({
      next: u => { this.users = u; this.loading = false; },
      error: e => { this.error = e?.error?.error || 'Failed to load users.'; this.loading = false; }
    });
  }

  openCreate(): void { this.editUser = null; this.showUserModal = true; }
  openEdit(u: User): void { this.editUser = u; this.showUserModal = true; }

  closeModal(): void { this.showUserModal = false; this.editUser = null; this.loadUsers(); }

  resetTotp(u: User): void {
    if (!confirm(`Reset 2FA for "${u.username}"? They will need to re-enroll.`)) return;
    this.usersService.resetTotp(u.id).subscribe({ next: () => this.loadUsers(), error: e => alert(e?.error?.error || 'Failed.') });
  }

  deleteUser(u: User): void {
    if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
    this.usersService.deleteUser(u.id).subscribe({ next: () => this.loadUsers(), error: e => alert(e?.error?.error || 'Failed.') });
  }

  isSelf(u: User): boolean { return String(u.id) === String(this.selfId); }
}
