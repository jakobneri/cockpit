import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { User } from '../models/types';

@Injectable({ providedIn: 'root' })
export class UsersService {
  constructor(private api: ApiService) {}

  getUsers(): Observable<User[]> {
    return this.api.get<User[]>('/api/users');
  }

  createUser(body: { username: string; passwordHash: string; role: string }): Observable<User> {
    return this.api.post<User>('/api/users', body);
  }

  updateUser(id: number, body: { username: string; role: string; passwordHash?: string }): Observable<User> {
    return this.api.put<User>(`/api/users/${id}`, body);
  }

  deleteUser(id: number): Observable<unknown> {
    return this.api.delete(`/api/users/${id}`);
  }

  resetTotp(id: number): Observable<unknown> {
    return this.api.delete(`/api/users/${id}/totp`);
  }

  getMe(): Observable<{ totp_enabled: boolean; username: string; role: string }> {
    return this.api.get('/api/auth/me');
  }

  changePassword(body: { currentPasswordHash: string; newPasswordHash: string }): Observable<unknown> {
    return this.api.put('/api/auth/me/password', body);
  }

  setupTotp(): Observable<{ qrDataUrl: string; secret: string }> {
    return this.api.post('/api/auth/totp/setup');
  }

  confirmTotp(code: string): Observable<unknown> {
    return this.api.post('/api/auth/totp/confirm', { code });
  }

  disableTotp(): Observable<unknown> {
    return this.api.delete('/api/auth/totp');
  }
}
