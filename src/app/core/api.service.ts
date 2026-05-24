import { HttpClient, HttpHeaders, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, throwError, from } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { AuthService } from './auth.service';

@Injectable({ providedIn: 'root' })
export class ApiService {
  constructor(
    private http: HttpClient,
    private auth: AuthService,
    private router: Router
  ) {}

  private headers(): HttpHeaders {
    const token = this.auth.getToken();
    return token
      ? new HttpHeaders({ Authorization: `Bearer ${token}` })
      : new HttpHeaders();
  }

  get<T>(url: string): Observable<T> {
    return this.http.get<T>(url, { headers: this.headers() }).pipe(
      catchError((err: HttpErrorResponse) => this.handle401(err, () => this.get<T>(url)))
    );
  }

  post<T>(url: string, body?: unknown): Observable<T> {
    return this.http.post<T>(url, body, { headers: this.headers() }).pipe(
      catchError((err: HttpErrorResponse) => this.handle401(err, () => this.post<T>(url, body)))
    );
  }

  put<T>(url: string, body?: unknown): Observable<T> {
    return this.http.put<T>(url, body, { headers: this.headers() }).pipe(
      catchError((err: HttpErrorResponse) => this.handle401(err, () => this.put<T>(url, body)))
    );
  }

  delete<T>(url: string): Observable<T> {
    return this.http.delete<T>(url, { headers: this.headers() }).pipe(
      catchError((err: HttpErrorResponse) => this.handle401(err, () => this.delete<T>(url)))
    );
  }

  private handle401<T>(
    err: HttpErrorResponse,
    retry: () => Observable<T>
  ): Observable<T> {
    if (err.status !== 401) return throwError(() => err);
    return from(this.auth.tryRefresh()).pipe(
      switchMap(refreshed => {
        if (refreshed) return retry();
        this.auth.clearToken();
        this.router.navigate(['/login']);
        return throwError(() => err);
      })
    );
  }
}
