# LDAP Configuration Guide untuk IBC Monitor

## Overview
IBC Monitor mendukung autentikasi LDAP dengan role-based access control berdasarkan grup membership. Aplikasi telah dioptimalkan untuk kompatibilitas dengan lldap (Light LDAP).

## Konfigurasi .env

Untuk menggunakan LDAP authentication, set konfigurasi berikut di file `.env`:

```bash
# Authentication Method
AUTH_METHOD=ldap

# LDAP Server Configuration
LDAP_SERVER=ldap://ldap.hub.roomit.xyz
LDAP_PORT=3890
LDAP_BIND_DN=uid=admin,ou=people,dc=roomit,dc=xyz
LDAP_BIND_PASSWORD=your-bind-password
LDAP_USER_SEARCH_BASE=ou=people,dc=roomit,dc=xyz
LDAP_USER_SEARCH_FILTER=(mail={username})
LDAP_USER_ATTRIBUTES=uid,cn,mail,memberOf

# LDAP Group-based Role Assignment
LDAP_ADMIN_GROUPS=cn=lldap_admin,ou=groups,dc=roomit,dc=xyz
LDAP_MONITORING_GROUPS=cn=lldap_web_admin,ou=groups,dc=roomit,dc=xyz

# Optional: Enable TLS
# LDAP_TLS_ENABLED=true
```

## Pengaturan Database

Untuk mengaktifkan LDAP authentication, update database configuration:

```sql
UPDATE app_config SET config_value = 'ldap' WHERE config_key = 'auth_method';
```

Atau gunakan API endpoint (sebagai admin):
```bash
curl -X POST http://localhost:3002/api/config -H "Content-Type: application/json" -H "Authorization: Bearer your-jwt-token" -d '{
  "auth_method": "ldap"
}'
```

## Role Assignment

### Admin Role
Users yang menjadi member dari grup-grup berikut akan mendapat role 'admin':
- `cn=lldap_admin,ou=groups,dc=roomit,dc=xyz`
- `cn=administrators,ou=groups,dc=roomit,dc=xyz` (jika ditambahkan)

### Monitoring Role  
Users yang menjadi member dari grup-grup berikut akan mendapat role 'monitoring':
- `cn=lldap_web_admin,ou=groups,dc=roomit,dc=xyz`
- `cn=ibc-users,ou=groups,dc=roomit,dc=xyz` (jika ditambahkan)

## Login Process

1. **Input**: User login menggunakan email address (misal: `admin@roomit.xyz`)
2. **Search**: Sistem mencari user di LDAP menggunakan filter `(mail={username})`
3. **Authentication**: Sistem mencoba bind dengan credentials user
4. **Group Check**: Sistem mengecek membership user di authorized groups
5. **Role Assignment**: User diberi role berdasarkan grup membership
6. **Database**: User dicreate/update di database lokal dengan role yang sesuai

## Troubleshooting

### 1. LDAP Server Connection Issues
```
Error: getaddrinfo ENOTFOUND ldap.hub.roomit.xyz
```
**Solution**: 
- Pastikan hostname LDAP server bisa di-resolve
- Cek network connectivity ke LDAP server
- Gunakan IP address jika hostname bermasalah

### 2. Bind Authentication Failed
```
LDAP bind error: Invalid credentials
```
**Solution**:
- Cek `LDAP_BIND_DN` dan `LDAP_BIND_PASSWORD`
- Pastikan service account memiliki permission untuk search users dan groups

### 3. User Not Found
```
User not found
```
**Solution**:
- Cek `LDAP_USER_SEARCH_BASE` dan `LDAP_USER_SEARCH_FILTER`
- Untuk lldap, pastikan menggunakan `(mail={username})` untuk email-based login
- Cek user exists di LDAP directory

### 4. User Not Authorized
```
User not authorized
```
**Solution**:
- User bukan member dari authorized groups
- Cek `LDAP_ADMIN_GROUPS` dan `LDAP_MONITORING_GROUPS` configuration
- Pastikan user sudah ditambahkan ke grup yang sesuai di LDAP

### 5. Group Membership Detection Failed
**Solution**:
- lldap mungkin menggunakan format grup yang berbeda
- Sistem akan mencoba beberapa object class: `groupOfNames`, `groupOfUniqueNames`, `group`
- Cek logs untuk debug informasi

## Testing LDAP Configuration

1. **Test Connection**:
```bash
curl -X POST http://localhost:3002/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin@roomit.xyz","password":"your-password"}'
```

2. **Check Logs**:
```bash
# Enable debug logging
LOG_LEVEL=debug

# Monitor logs for LDAP authentication details
tail -f logs/ibc-monitor.log
```

3. **Test dengan ldapsearch**:
```bash
# Test bind
ldapsearch -x -H ldap://ldap.hub.roomit.xyz:3890 -D "uid=admin,ou=people,dc=roomit,dc=xyz" -W -b "dc=roomit,dc=xyz" "(objectClass=*)"

# Test user search
ldapsearch -x -H ldap://ldap.hub.roomit.xyz:3890 -D "uid=admin,ou=people,dc=roomit,dc=xyz" -W -b "ou=people,dc=roomit,dc=xyz" "(mail=admin@roomit.xyz)"

# Test group search
ldapsearch -x -H ldap://ldap.hub.roomit.xyz:3890 -D "uid=admin,ou=people,dc=roomit,dc=xyz" -W -b "ou=groups,dc=roomit,dc=xyz" "(objectClass=groupOfNames)"
```

## lldap Specific Configuration

lldap menggunakan struktur yang sedikit berbeda dari LDAP tradisional:

```
# User Structure
ou=people,dc=roomit,dc=xyz
├── uid=admin,ou=people,dc=roomit,dc=xyz
├── uid=user1,ou=people,dc=roomit,dc=xyz

# Group Structure  
ou=groups,dc=roomit,dc=xyz
├── cn=lldap_admin,ou=groups,dc=roomit,dc=xyz
├── cn=lldap_web_admin,ou=groups,dc=roomit,dc=xyz
```

## Security Notes

1. **Bind Password**: Simpan `LDAP_BIND_PASSWORD` dengan aman, jangan commit ke repository
2. **TLS**: Aktifkan TLS untuk production: `LDAP_TLS_ENABLED=true`
3. **Network**: Batasi akses network ke LDAP server hanya dari aplikasi server
4. **Permissions**: Service account hanya perlu read access ke users dan groups
5. **Monitoring**: Monitor failed authentication attempts dan LDAP connection issues

## Migration dari SQLite ke LDAP

1. **Backup** database existing
2. **Test** LDAP configuration di development environment
3. **Update** `auth_method` di database
4. **Restart** aplikasi
5. **Test** login dengan LDAP users
6. **Monitor** logs untuk issues

Existing local users di database tidak akan terhapus dan bisa dipindah kembali ke SQLite jika diperlukan.