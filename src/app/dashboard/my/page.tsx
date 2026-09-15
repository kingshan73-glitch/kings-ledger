"use client";

import {
  CircleUserRound,
  IdCard,
  LockKeyhole,
  LogOut,
  Mail,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  DetailGrid,
  DetailItem,
  ErrorState,
  LoadingState,
  PageHeader,
  PageShell,
  SectionCard,
  SectionIntro,
  StatCard,
  StatsGrid,
} from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMasking } from "@/components/masking-provider";
import { clearClientSession, createClient } from "@/lib/supabase/client";
import { sendLog } from "@/lib/log-client";

type MyEmployee = {
  name: string;
  department: string | null;
  position: string | null;
  employee_type: string | null;
  email: string | null;
  phone: string | null;
  login_id: string | null;
};

export default function MyPage() {
  const supabase = useMemo(() => createClient(), []);
  const { mask } = useMasking();

  const [loading, setLoading] = useState(true);
  const [employee, setEmployee] = useState<MyEmployee | null>(null);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({
    name: "",
    department: "",
    position: "",
    email: "",
    phone: "",
    login_id: "",
  });
  const [saving, setSaving] = useState(false);
  const [pwDialogOpen, setPwDialogOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);

    try {
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser();

      if (authError || !user) {
        setEmployee(null);
        setLoading(false);
        return;
      }

      const { data: employeeRow } = await supabase
        .from("employees")
        .select("name, department, position, employee_type, email, phone, login_id")
        .eq("auth_uid", user.id)
        .maybeSingle();

      setEmployee({
        name: employeeRow?.name ?? user.email?.split("@")[0] ?? "사용자",
        department: employeeRow?.department ?? null,
        position: employeeRow?.position ?? null,
        employee_type: employeeRow?.employee_type ?? "직원",
        email: employeeRow?.email ?? user.email ?? null,
        phone: employeeRow?.phone ?? null,
        login_id: employeeRow?.login_id ?? null,
      });
    } catch {
      toast.error("내 정보 조회에 실패했습니다.");
      setEmployee(null);
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  const startEditing = () => {
    if (!employee) return;

    setEditForm({
      name: employee.name || "",
      department: employee.department || "",
      position: employee.position || "",
      email: employee.email || "",
      phone: employee.phone || "",
      login_id: employee.login_id || "",
    });
    setEditing(true);
  };

  const handleSaveProfile = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!editForm.name.trim()) {
      toast.error("이름은 필수 항목입니다.");
      return;
    }

    if (!editForm.login_id.trim()) {
      toast.error("아이디는 필수 항목입니다.");
      return;
    }

    setSaving(true);
    try {
      const response = await fetch("/api/my/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editForm),
      });

      const data = await response.json();
      if (!response.ok) {
        console.error("정보 수정 실패:", data.error);
        toast.error("정보 수정에 실패했습니다. 잠시 후 다시 시도해주세요.");
        return;
      }

      toast.success("내 정보가 수정되었습니다.");
      setEditing(false);
      await load();
    } catch {
      toast.error("서버 오류가 발생했습니다.");
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!currentPassword || !newPassword || !confirmPassword) {
      toast.error("현재/새 비밀번호를 모두 입력해주세요.");
      return;
    }

    if (newPassword !== confirmPassword) {
      toast.error("새 비밀번호가 일치하지 않습니다.");
      return;
    }

    if (newPassword.length < 6) {
      toast.error("새 비밀번호는 6자 이상이어야 합니다.");
      return;
    }

    setChangingPassword(true);
    try {
      const response = await fetch("/api/employees/password", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        // 서버가 준 사유를 그대로 보여준다 — 일반 문구로 덮으면 왜 막혔는지 알 수 없다.
        // (본인 인증된 세션에서 자기 비밀번호를 바꾸는 화면이라 사유 노출이 안전하다.)
        toast.error(data.error || "비밀번호 변경에 실패했습니다. 잠시 후 다시 시도해주세요.");
        return;
      }

      toast.success("비밀번호가 변경되었습니다.");
      setPwDialogOpen(false);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch {
      toast.error("서버 오류가 발생했습니다.");
    } finally {
      setChangingPassword(false);
    }
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      sendLog("LOGOUT", "로그아웃");
      await clearClientSession();
      window.location.href = "/login";
    } finally {
      setLoggingOut(false);
    }
  };

  if (loading) {
    return (
      <LoadingState
        title="내 정보를 불러오는 중입니다."
        description="프로필과 계정 설정을 준비하고 있습니다."
      />
    );
  }

  if (!employee) {
    return (
      <ErrorState
        title="내 정보를 불러오지 못했습니다."
        description="세션이 만료되었거나 직원 정보가 연결되지 않았을 수 있습니다."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()}>
              다시 시도
            </Button>
            <Button variant="outline" size="sm" onClick={() => void handleLogout()} disabled={loggingOut}>
              <LogOut className="h-4 w-4" />
              {loggingOut ? "로그아웃 중..." : "로그아웃"}
            </Button>
          </div>
        }
      />
    );
  }

  return (
    <PageShell>
      <PageHeader
        title="마이페이지"
        funKey="my"
        description="로그인 계정과 비밀번호를 관리합니다."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => {
                setCurrentPassword("");
                setNewPassword("");
                setConfirmPassword("");
                setPwDialogOpen(true);
              }}
            >
              <LockKeyhole className="h-4 w-4" />
              비밀번호 변경
            </Button>
            <Button variant="outline" onClick={() => void handleLogout()} disabled={loggingOut}>
              <LogOut className="h-4 w-4" />
              {loggingOut ? "로그아웃 중..." : "로그아웃"}
            </Button>
          </>
        }
      />

      <StatsGrid columns={3}>
        <StatCard
          label="이름"
          value={mask("name", employee.name)}
          icon={CircleUserRound}
        />
        <StatCard
          label="로그인 ID"
          value={employee.login_id ? mask("name", employee.login_id) : "-"}
          icon={IdCard}
        />
        <StatCard
          label="이메일"
          value={employee.email ? mask("email", employee.email) : "-"}
          icon={Mail}
        />
      </StatsGrid>

      <section className="space-y-4">
        <SectionIntro
          title="기본 정보"
          description="이름·로그인 ID·이메일을 확인하고 수정할 수 있습니다."
          action={
            !editing ? (
              <Button variant="outline" size="sm" onClick={startEditing}>
                수정
              </Button>
            ) : null
          }
        />

        <SectionCard>
          {editing ? (
            <form onSubmit={handleSaveProfile} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="이름 *" htmlFor="edit-name">
                  <Input
                    id="edit-name"
                    value={editForm.name}
                    onChange={(event) => setEditForm({ ...editForm, name: event.target.value })}
                    required
                  />
                </Field>
                <Field label="로그인 ID *" htmlFor="edit-login-id">
                  <Input
                    id="edit-login-id"
                    value={editForm.login_id}
                    onChange={(event) =>
                      setEditForm({ ...editForm, login_id: event.target.value })
                    }
                    required
                  />
                </Field>
                <Field label="이메일" htmlFor="edit-email">
                  <Input
                    id="edit-email"
                    type="email"
                    value={editForm.email}
                    onChange={(event) => setEditForm({ ...editForm, email: event.target.value })}
                  />
                </Field>
              </div>

              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                  취소
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving ? "저장 중..." : "저장"}
                </Button>
              </div>
            </form>
          ) : (
            <DetailGrid className="xl:grid-cols-2">
              <DetailItem label="이름" value={mask("name", employee.name)} />
              <DetailItem label="로그인 ID" value={employee.login_id ? mask("name", employee.login_id) : "-"} />
              <DetailItem label="이메일" value={employee.email ? mask("email", employee.email) : "-"} />
            </DetailGrid>
          )}
        </SectionCard>
      </section>

      <Dialog open={pwDialogOpen} onOpenChange={setPwDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>비밀번호 변경</DialogTitle>
            <DialogDescription>보안을 위해 주기적으로 비밀번호를 변경하세요.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleChangePassword} className="space-y-4">
            <div className="space-y-4">
              <Field label="현재 비밀번호" htmlFor="current-password">
                <Input
                  id="current-password"
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  required
                />
              </Field>
              <Field label="새 비밀번호" htmlFor="new-password">
                <Input
                  id="new-password"
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  required
                  minLength={6}
                />
              </Field>
              <Field label="새 비밀번호 확인" htmlFor="confirm-password">
                <Input
                  id="confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  required
                  minLength={6}
                />
              </Field>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPwDialogOpen(false)}>
                취소
              </Button>
              <Button type="submit" disabled={changingPassword}>
                {changingPassword ? "변경 중..." : "변경"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

    </PageShell>
  );
}

function Field({
  children,
  htmlFor,
  label,
}: React.PropsWithChildren<{ htmlFor?: string; label: string }>) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
