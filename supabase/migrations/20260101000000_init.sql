-- kinghama의 가계부 템플릿 초기 스키마 (원본 라이브 DB public 스키마 전체 덤프)
-- 빈 Supabase 프로젝트에 supabase db push 로 한 번에 적용됩니다.
-- 정리: pg_dump 산출물에서 psql 메타명령과 Supabase 내부 권한구문(스키마 GRANT/COMMENT,
--       DEFAULT PRIVILEGES)을 제거해 빈 프로젝트에서 바로 적용되게 함

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--



--
-- Name: generate_project_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_project_number() RETURNS text
    LANGUAGE plpgsql
    AS $_$
    DECLARE
      yy TEXT;
      seq INT;
    BEGIN
      yy := TO_CHAR(NOW(), 'YY');
      SELECT COALESCE(MAX(
        CAST(SPLIT_PART(project_number, '-', 2) AS INT)
      ), 0) + 1
      INTO seq
      FROM projects
      WHERE project_number LIKE yy || '-%'
        AND SPLIT_PART(project_number, '-', 2) ~ '^[0-9]+$';
      RETURN yy || '-' || seq::TEXT;
    END;
    $_$;


--
-- Name: generate_quotation_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_quotation_number() RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  yymm TEXT;
  letters TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ';  -- I, O 제외 (1, 0과 혼동)
  digits TEXT := '123456789';                    -- 0 제외
  letter CHAR(1);
  digit CHAR(1);
  candidate TEXT;
  attempts INT := 0;
BEGIN
  yymm := TO_CHAR(NOW(), 'YYMM');

  LOOP
    letter := SUBSTR(letters, FLOOR(RANDOM() * LENGTH(letters) + 1)::INT, 1);
    digit := SUBSTR(digits, FLOOR(RANDOM() * LENGTH(digits) + 1)::INT, 1);
    candidate := 'Q' || yymm || '-' || letter || digit;

    -- 중복 확인
    IF NOT EXISTS (SELECT 1 FROM quotations WHERE quotation_number = candidate) THEN
      RETURN candidate;
    END IF;

    attempts := attempts + 1;
    IF attempts > 100 THEN
      RAISE EXCEPTION 'Failed to generate unique quotation number after 100 attempts';
    END IF;
  END LOOP;
END;
$$;


--
-- Name: normalize_business_name(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.normalize_business_name(value text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select lower(
    regexp_replace(
      replace(
        replace(
          replace(
            replace(
              replace(
                replace(
                  replace(
                    replace(
                      replace(
                        replace(
                          replace(
                            replace(
                              replace(
                                regexp_replace(coalesce(value, ''), '[㈜㈔]', '', 'g'),
                                '(주)',
                                ''
                              ),
                              '(유)',
                              ''
                            ),
                            '(재)',
                            ''
                          ),
                          '(사)',
                          ''
                        ),
                        '주식회사',
                        ''
                      ),
                      '유한회사',
                      ''
                    ),
                    '재단법인',
                    ''
                  ),
                  '사단법인',
                  ''
                ),
                '유한책임회사',
                ''
              ),
              ' ',
              ''
            ),
            '-',
            ''
          ),
          '_',
          ''
        ),
        '.',
        ''
      ),
      '[·・()[\]{}''"&]',
      '',
      'g'
    )
  );
$$;


--
-- Name: replace_schedule_attendees_atomic(uuid[], uuid[], uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.replace_schedule_attendees_atomic(p_schedule_ids uuid[], p_attendee_ids uuid[], p_actor_employee_id uuid, p_is_admin boolean DEFAULT false) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  accessible_count integer;
  requested_count integer;
begin
  requested_count := coalesce(array_length(p_schedule_ids, 1), 0);

  if requested_count = 0 then
    return;
  end if;

  if not p_is_admin then
    select count(distinct s.id)
      into accessible_count
    from schedules s
    left join schedule_attendees sa
      on sa.schedule_id = s.id
    where s.id = any(p_schedule_ids)
      and (s.created_by = p_actor_employee_id or sa.employee_id = p_actor_employee_id);

    if accessible_count <> requested_count then
      raise exception 'schedule access denied';
    end if;
  end if;

  delete from schedule_attendees
  where schedule_id = any(p_schedule_ids);

  if coalesce(array_length(p_attendee_ids, 1), 0) = 0 then
    return;
  end if;

  insert into schedule_attendees (schedule_id, employee_id)
  select schedule_id, employee_id
  from unnest(p_schedule_ids) as schedule_id
  cross join unnest(p_attendee_ids) as employee_id;
end;
$$;


--
-- Name: reset_schedule_slack_reminder_sent_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reset_schedule_slack_reminder_sent_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.start_at IS DISTINCT FROM OLD.start_at OR
    NEW.end_at IS DISTINCT FROM OLD.end_at OR
    NEW.all_day IS DISTINCT FROM OLD.all_day
  ) THEN
    NEW.slack_reminder_sent_at = NULL;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: sync_revenue_paid_from_deposit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_revenue_paid_from_deposit() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  matched_revenue_id uuid;
begin
  if new.revenue_id is null then
    select case when count(*) = 1 then min(candidate.id) else null end
      into matched_revenue_id
      from (
        select r.id
          from public.revenues r
          left join public.projects p
            on p.id = r.project_id
          left join public.customers c
            on c.id = p.customer_id
         where r.is_paid = false
           and r.total_amount = new.amount
           and (
             public.normalize_business_name(new.depositor_name) <> ''
             and public.normalize_business_name(new.depositor_name) in (
               public.normalize_business_name(c.name),
               public.normalize_business_name(c.account_holder),
               public.normalize_business_name(p.client),
               public.normalize_business_name(p.name),
               public.normalize_business_name(r.title)
             )
           )
      ) candidate;

    if matched_revenue_id is not null then
      new.revenue_id := matched_revenue_id;
    end if;
  end if;

  if new.revenue_id is not null
     and (
       tg_op = 'INSERT'
       or old.revenue_id is distinct from new.revenue_id
       or old.deposit_date is distinct from new.deposit_date
     ) then
    update public.revenues
       set is_paid = true,
           paid_date = new.deposit_date
     where id = new.revenue_id;
  end if;

  return new;
end;
$$;


--
-- Name: update_google_oauth_tokens_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_google_oauth_tokens_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


--
-- Name: update_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: _meeting_started_at_backfill_20260413; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public._meeting_started_at_backfill_20260413 (
    meeting_id uuid NOT NULL,
    original_started_at timestamp with time zone NOT NULL,
    original_created_at timestamp with time zone NOT NULL,
    backed_up_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_memories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_auth_uid uuid NOT NULL,
    namespace text NOT NULL,
    key text NOT NULL,
    value jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    key_hash text NOT NULL,
    key_prefix text NOT NULL,
    created_by text NOT NULL,
    last_used_at timestamp with time zone,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    key_encrypted text
);


--
-- Name: app_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    level text DEFAULT 'INFO'::text NOT NULL,
    action text NOT NULL,
    resource text,
    resource_id text,
    message text NOT NULL,
    actor_id text,
    actor_name text,
    ip_address text,
    details jsonb,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT app_logs_level_check CHECK ((level = ANY (ARRAY['INFO'::text, 'ERROR'::text])))
);


--
-- Name: app_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_users (
    id bigint NOT NULL,
    user_id uuid,
    role text DEFAULT 'user'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT app_users_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'user'::text])))
);


--
-- Name: app_users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.app_users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: app_users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.app_users_id_seq OWNED BY public.app_users.id;


--
-- Name: business_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.business_cards (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    company_name text,
    "position" text,
    email text,
    phone text,
    input_method text DEFAULT 'manual'::text NOT NULL,
    image_name text,
    image_mime_type text,
    image_base64 text,
    ocr_raw_text text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    address text,
    drive_file_id text,
    drive_web_view_link text,
    drive_web_content_link text,
    CONSTRAINT business_cards_input_method_check CHECK ((input_method = ANY (ARRAY['photo'::text, 'manual'::text])))
);


--
-- Name: card_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.card_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    card_id uuid,
    card_last4 text,
    amount integer NOT NULL,
    merchant text,
    approved_at timestamp with time zone NOT NULL,
    raw_text text NOT NULL,
    parse_status text DEFAULT 'parsed'::text NOT NULL,
    description text,
    receipt_url text,
    receipt_required boolean DEFAULT false NOT NULL,
    expense_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    currency text DEFAULT 'KRW'::text NOT NULL,
    foreign_amount numeric(14,2),
    type_id uuid,
    is_cancellation boolean DEFAULT false NOT NULL,
    paired_transaction_id uuid,
    CONSTRAINT card_transactions_parse_status_check CHECK ((parse_status = ANY (ARRAY['parsed'::text, 'partial'::text, 'failed'::text]))),
    CONSTRAINT card_transactions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'ignored'::text])))
);


--
-- Name: chat_usage_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_usage_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_auth_uid uuid NOT NULL,
    user_message text NOT NULL,
    assistant_message text,
    model text DEFAULT 'claude-sonnet-4-6'::text NOT NULL,
    input_tokens integer DEFAULT 0 NOT NULL,
    output_tokens integer DEFAULT 0 NOT NULL,
    input_cost numeric(10,6) DEFAULT 0 NOT NULL,
    output_cost numeric(10,6) DEFAULT 0 NOT NULL,
    total_cost numeric(10,6) DEFAULT 0 NOT NULL,
    tool_calls_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source text DEFAULT 'chat'::text NOT NULL
);


--
-- Name: contract_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contract_audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    action text NOT NULL,
    actor_type text DEFAULT 'system'::text NOT NULL,
    actor_id text,
    actor_name text,
    actor_email text,
    ip_address text,
    user_agent text,
    details jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contract_audit_logs_actor_type_check CHECK ((actor_type = ANY (ARRAY['internal'::text, 'customer'::text, 'system'::text])))
);


--
-- Name: contract_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contract_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    title_template text DEFAULT '{{contract_title}}'::text NOT NULL,
    body_template text DEFAULT '{{contract_body}}'::text NOT NULL,
    default_variables jsonb DEFAULT '{}'::jsonb NOT NULL,
    owner_auth_uid uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contracts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contracts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    template_id uuid,
    customer_id uuid,
    project_id uuid,
    title text NOT NULL,
    content text NOT NULL,
    variables jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT '작성중'::text NOT NULL,
    customer_name text,
    customer_phone text,
    customer_email text,
    owner_auth_uid uuid,
    owner_name text,
    owner_email text,
    internal_sign_type text,
    internal_signer_name text,
    internal_signature_data text,
    internal_signed_at timestamp with time zone,
    customer_sign_type text,
    customer_signer_name text,
    customer_signature_data text,
    customer_signed_at timestamp with time zone,
    sign_token text,
    sign_requested_at timestamp with time zone,
    completed_at timestamp with time zone,
    pdf_file_name text,
    pdf_size_bytes integer,
    pdf_sha256 text,
    pdf_generated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contracts_customer_sign_type_check CHECK ((customer_sign_type = ANY (ARRAY['서명'::text, '도장'::text]))),
    CONSTRAINT contracts_internal_sign_type_check CHECK ((internal_sign_type = ANY (ARRAY['서명'::text, '도장'::text]))),
    CONSTRAINT contracts_status_check CHECK ((status = ANY (ARRAY['작성중'::text, '발송완료'::text, '완료'::text, '취소'::text])))
);


--
-- Name: corporate_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.corporate_cards (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    alias text,
    last4 text NOT NULL,
    holder_employee_id uuid,
    issuer text,
    is_active boolean DEFAULT true NOT NULL,
    memo text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: customer_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    name text NOT NULL,
    "position" text,
    phone text,
    email text,
    memo text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: customer_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    title text,
    content text,
    link_url text,
    author_employee_id uuid,
    author_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_notes_check CHECK ((COALESCE(NULLIF(btrim(title), ''::text), NULLIF(btrim(content), ''::text), NULLIF(btrim(link_url), ''::text)) IS NOT NULL))
);


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_type text,
    name text NOT NULL,
    business_number text,
    contact_name text,
    contact_email text,
    contact_phone text,
    address text,
    memo text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    representative_name text,
    tax_category text,
    default_withholding_rate numeric(5,4),
    bank_name text,
    account_number text,
    account_holder text,
    is_vendor boolean GENERATED ALWAYS AS ((tax_category IS NOT NULL)) STORED,
    resident_number text,
    drive_folder_id text,
    CONSTRAINT customers_customer_type_check CHECK (((customer_type IS NULL) OR (customer_type = ANY (ARRAY['개인'::text, '개인사업자'::text, '법인'::text])))),
    CONSTRAINT customers_tax_category_check CHECK ((tax_category = ANY (ARRAY['personal_withholding'::text, 'business_vat'::text, 'corporate_vat'::text, 'none'::text])))
);


--
-- Name: deposits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deposits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deposit_date date NOT NULL,
    amount integer NOT NULL,
    depositor_name text NOT NULL,
    bank_name text,
    account_alias text,
    revenue_id uuid,
    source text DEFAULT 'manual'::text NOT NULL,
    raw_message text,
    memo text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deposits_amount_check CHECK ((amount > 0)),
    CONSTRAINT deposits_source_check CHECK ((source = ANY (ARRAY['webhook'::text, 'manual'::text])))
);


--
-- Name: employees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    department text,
    "position" text,
    email text,
    phone text,
    hire_date date,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    login_id text,
    auth_uid uuid,
    employee_type text DEFAULT '직원'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    failed_login_count integer DEFAULT 0 NOT NULL,
    failed_login_window_started_at timestamp with time zone,
    last_failed_login_at timestamp with time zone,
    last_login_at timestamp with time zone,
    slack_id text,
    focused_task_id uuid,
    is_finance boolean DEFAULT false NOT NULL,
    CONSTRAINT employees_employee_type_check CHECK ((employee_type = ANY (ARRAY['관리자'::text, '직원'::text])))
);


--
-- Name: expense_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expense_status_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    expense_id uuid NOT NULL,
    from_status text,
    to_status text NOT NULL,
    actor_id uuid,
    actor_name text,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: expense_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expense_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    account_code text,
    is_vat_deductible boolean DEFAULT true NOT NULL
);


--
-- Name: expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expenses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    revenue_id uuid,
    project_id uuid,
    type_id uuid,
    title text NOT NULL,
    vendor_name text,
    total_amount integer NOT NULL,
    supply_amount integer NOT NULL,
    vat_amount integer DEFAULT 0 NOT NULL,
    vat_included boolean DEFAULT true NOT NULL,
    purchase_date date,
    payment_date date,
    purchase_tax_invoice_received boolean DEFAULT false NOT NULL,
    purchase_tax_invoice_date date,
    purchase_tax_invoice_not_required boolean DEFAULT false NOT NULL,
    memo text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    vendor_id uuid,
    tax_category text,
    withholding_rate numeric(5,4),
    withholding_amount integer DEFAULT 0 NOT NULL,
    net_payment_amount integer GENERATED ALWAYS AS ((total_amount - COALESCE(withholding_amount, 0))) STORED,
    requested_by uuid,
    requested_at timestamp with time zone,
    approver_id uuid,
    approved_at timestamp with time zone,
    rejected_reason text,
    cancelled_at timestamp with time zone,
    cancelled_reason text,
    slack_thread_ts text,
    source text DEFAULT 'manual'::text NOT NULL,
    card_transaction_id uuid,
    recurring_expense_id uuid,
    receipt_url text,
    CONSTRAINT expenses_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'card'::text, 'recurring'::text]))),
    CONSTRAINT expenses_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'requested'::text, 'approved'::text, 'rejected'::text, 'scheduled'::text, 'paid'::text, 'cancelled'::text]))),
    CONSTRAINT expenses_tax_category_check CHECK ((tax_category = ANY (ARRAY['personal_withholding'::text, 'business_vat'::text, 'corporate_vat'::text, 'none'::text])))
);


--
-- Name: gemini_usage_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gemini_usage_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_auth_uid uuid NOT NULL,
    feature text DEFAULT 'business_card_ocr'::text NOT NULL,
    model text NOT NULL,
    input_tokens integer DEFAULT 0 NOT NULL,
    output_tokens integer DEFAULT 0 NOT NULL,
    input_cost numeric(10,6) DEFAULT 0 NOT NULL,
    output_cost numeric(10,6) DEFAULT 0 NOT NULL,
    total_cost numeric(10,6) DEFAULT 0 NOT NULL,
    image_count integer DEFAULT 1 NOT NULL,
    request_summary text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: google_calendar_sync_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.google_calendar_sync_states (
    calendar_id text NOT NULL,
    sync_token text,
    channel_id text,
    channel_resource_id text,
    channel_token text,
    channel_expiration timestamp with time zone,
    last_synced_at timestamp with time zone,
    last_message_number bigint,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: google_oauth_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.google_oauth_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    gmail_email text NOT NULL,
    access_token text NOT NULL,
    refresh_token text NOT NULL,
    token_expiry timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_global boolean DEFAULT false NOT NULL
);


--
-- Name: lead_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lead_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid NOT NULL,
    author_employee_id uuid,
    author_name text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lead_comments_content_check CHECK ((char_length(btrim(content)) > 0))
);


--
-- Name: leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_name text NOT NULL,
    contact_name text NOT NULL,
    phone text NOT NULL,
    email text,
    "position" text,
    referral_source text,
    industry text,
    automation_areas text[],
    budget text,
    desired_timeline text,
    inquiry_detail text,
    status text DEFAULT '신규'::text NOT NULL,
    source text DEFAULT '폼문의'::text NOT NULL,
    assigned_to uuid,
    customer_id uuid,
    memo text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    lead_type text DEFAULT '개발'::text NOT NULL,
    edu_schedule text,
    edu_filming_schedule text,
    edu_delivery_mode text,
    edu_hourly_rate integer,
    edu_estimated_hours numeric(6,1),
    edu_estimated_total integer,
    CONSTRAINT leads_edu_delivery_mode_check CHECK ((edu_delivery_mode = ANY (ARRAY['온라인'::text, '오프라인'::text, '혼합'::text]))),
    CONSTRAINT leads_lead_type_check CHECK ((lead_type = ANY (ARRAY['개발'::text, '교육'::text]))),
    CONSTRAINT leads_source_check CHECK ((source = ANY (ARRAY['폼문의'::text, '전화'::text, '이메일'::text, '소개'::text, '기타'::text]))),
    CONSTRAINT leads_status_check CHECK ((status = ANY (ARRAY['신규'::text, '상담중'::text, '견적발송'::text, '계약완료'::text, '실패'::text, '보류'::text])))
);


--
-- Name: meetings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meetings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    project_id uuid,
    transcript text DEFAULT ''::text,
    status text DEFAULT '진행중'::text,
    started_at timestamp with time zone DEFAULT now(),
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    summary text DEFAULT ''::text NOT NULL,
    customer_id uuid,
    lead_id uuid,
    drive_file_id text
);


--
-- Name: notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text,
    content text,
    link_url text,
    project_id uuid,
    customer_id uuid,
    author_employee_id uuid,
    author_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notification_filters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_filters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phrase text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: project_assignees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_assignees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: project_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    title text,
    content text,
    link_url text,
    author_employee_id uuid,
    author_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_notes_check CHECK ((COALESCE(NULLIF(btrim(title), ''::text), NULLIF(btrim(content), ''::text), NULLIF(btrim(link_url), ''::text)) IS NOT NULL))
);


--
-- Name: project_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    drive_folder_id text
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_number text NOT NULL,
    name text NOT NULL,
    client text,
    description text,
    status text DEFAULT '진행예정'::text,
    start_date date,
    end_date date,
    manager text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    drive_folder_id text,
    customer_id uuid,
    type_id uuid
);


--
-- Name: quotation_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quotation_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    quotation_id uuid NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    item_name text NOT NULL,
    specification text DEFAULT ''::text,
    unit text DEFAULT '식'::text NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    unit_price bigint DEFAULT 0 NOT NULL,
    supply_amount bigint DEFAULT 0 NOT NULL,
    remark text DEFAULT ''::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: quotations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quotations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    quotation_number text NOT NULL,
    quotation_date date DEFAULT CURRENT_DATE NOT NULL,
    valid_until date,
    status text DEFAULT '작성중'::text NOT NULL,
    customer_id uuid,
    recipient_name text NOT NULL,
    recipient_contact_name text,
    recipient_phone text,
    recipient_address text,
    supplier_name text DEFAULT ''::text NOT NULL,
    supplier_representative text DEFAULT ''::text NOT NULL,
    supplier_business_number text DEFAULT ''::text NOT NULL,
    supplier_phone text DEFAULT ''::text NOT NULL,
    supplier_manager text DEFAULT ''::text NOT NULL,
    supplier_address text DEFAULT ''::text,
    supplier_business_type text DEFAULT ''::text,
    supplier_business_category text DEFAULT ''::text,
    supply_total bigint DEFAULT 0 NOT NULL,
    vat_total bigint DEFAULT 0 NOT NULL,
    grand_total bigint DEFAULT 0 NOT NULL,
    payment_terms text,
    delivery_terms text,
    bank_account text DEFAULT ''::text NOT NULL,
    memo text,
    project_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    parent_id uuid,
    CONSTRAINT quotations_status_check CHECK ((status = ANY (ARRAY['작성중'::text, '발송완료'::text, '수락'::text, '거절'::text, '만료'::text])))
);


--
-- Name: recurring_expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recurring_expenses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    type_id uuid,
    vendor_name text,
    vendor_id uuid,
    amount integer NOT NULL,
    vat_included boolean DEFAULT true NOT NULL,
    day_of_month smallint NOT NULL,
    start_date date NOT NULL,
    end_date date,
    last_generated_month text,
    is_active boolean DEFAULT true NOT NULL,
    memo text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recurring_expenses_day_of_month_check CHECK (((day_of_month >= 1) AND (day_of_month <= 28)))
);


--
-- Name: resource_library_posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_library_posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    drive_folder_id text,
    author_employee_id uuid,
    author_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: revenues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.revenues (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid,
    title text NOT NULL,
    total_amount bigint DEFAULT 0 NOT NULL,
    supply_amount bigint DEFAULT 0 NOT NULL,
    vat_amount bigint DEFAULT 0 NOT NULL,
    revenue_date date,
    is_paid boolean DEFAULT false,
    paid_date date,
    is_tax_invoice_issued boolean DEFAULT false,
    tax_invoice_date date,
    memo text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    tax_invoice_not_required boolean DEFAULT false NOT NULL,
    vat_included boolean DEFAULT true NOT NULL,
    channel text,
    product_name text,
    external_order_id text,
    expected_payment_date date,
    tax_invoice_issue_status text DEFAULT 'not_issued'::text NOT NULL,
    tax_invoice_issuance_key text,
    tax_invoice_client_reference_id text,
    tax_invoice_issue_requested_at timestamp with time zone,
    tax_invoice_issued_at timestamp with time zone,
    tax_invoice_last_webhook_at timestamp with time zone,
    tax_invoice_url text,
    tax_invoice_nts_transaction_id text,
    tax_invoice_error_code text,
    tax_invoice_error_message text,
    tax_invoice_request_payload jsonb,
    tax_invoice_last_payload jsonb,
    type_id uuid,
    CONSTRAINT revenues_tax_invoice_issue_status_check CHECK ((tax_invoice_issue_status = ANY (ARRAY['not_issued'::text, 'issuing'::text, 'issued'::text, 'failed'::text])))
);


--
-- Name: schedule_attendees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule_attendees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    schedule_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: schedule_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    value text NOT NULL,
    label text NOT NULL,
    color text DEFAULT '#6b7280'::text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    description text,
    start_at timestamp with time zone NOT NULL,
    end_at timestamp with time zone NOT NULL,
    all_day boolean DEFAULT false,
    location text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    category text DEFAULT 'other'::text NOT NULL,
    project_id uuid,
    slack_reminder_sent_at timestamp with time zone,
    recurrence_type text DEFAULT 'none'::text NOT NULL,
    recurrence_end_date date,
    recurrence_group_id uuid,
    google_calendar_id text,
    google_event_id text,
    google_event_status text DEFAULT 'none'::text NOT NULL,
    google_etag text,
    google_updated_at timestamp with time zone,
    sync_source text DEFAULT 'local'::text NOT NULL,
    google_meet_link text,
    customer_id uuid,
    lead_id uuid,
    CONSTRAINT schedules_recurrence_type_check CHECK ((recurrence_type = ANY (ARRAY['none'::text, 'daily'::text, 'weekly'::text, 'monthly'::text])))
);


--
-- Name: COLUMN schedules.recurrence_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.schedules.recurrence_type IS '반복 유형: none(없음), daily(매일), weekly(매주), monthly(매월)';


--
-- Name: COLUMN schedules.recurrence_end_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.schedules.recurrence_end_date IS '반복 종료 날짜';


--
-- Name: COLUMN schedules.recurrence_group_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.schedules.recurrence_group_id IS '같은 반복 규칙에서 생성된 일정끼리 묶는 그룹 ID';


--
-- Name: settlement_data; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settlement_data (
    id bigint NOT NULL,
    filename text NOT NULL,
    data jsonb NOT NULL,
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: settlement_data_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.settlement_data_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: settlement_data_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.settlement_data_id_seq OWNED BY public.settlement_data.id;


--
-- Name: slack_pending_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.slack_pending_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slack_user_id text NOT NULL,
    user_auth_uid uuid NOT NULL,
    channel text NOT NULL,
    thread_ts text NOT NULL,
    confirmation_ts text NOT NULL,
    tool_name text NOT NULL,
    tool_input jsonb NOT NULL,
    summary text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:15:00'::interval) NOT NULL,
    executed_at timestamp with time zone,
    cancelled_at timestamp with time zone
);


--
-- Name: sms_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    expense_id uuid,
    customer_id uuid,
    template_code text,
    to_phone text NOT NULL,
    body text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    provider text,
    provider_msg_id text,
    error text,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sms_logs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'sent'::text, 'failed'::text])))
);


--
-- Name: sms_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_templates (
    code text NOT NULL,
    body text NOT NULL,
    vars jsonb DEFAULT '[]'::jsonb NOT NULL,
    description text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: suggestion_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.suggestion_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    suggestion_id uuid NOT NULL,
    author_employee_id uuid,
    author_name text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    comment_type text DEFAULT 'comment'::text NOT NULL,
    status_from text,
    status_to text,
    CONSTRAINT suggestion_comments_comment_type_check CHECK ((comment_type = ANY (ARRAY['comment'::text, 'status_change'::text]))),
    CONSTRAINT suggestion_comments_content_check CHECK ((char_length(btrim(content)) > 0))
);


--
-- Name: suggestion_posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.suggestion_posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    author_employee_id uuid,
    author_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT '대기중'::text NOT NULL,
    CONSTRAINT suggestion_posts_content_check CHECK ((char_length(btrim(content)) > 0)),
    CONSTRAINT suggestion_posts_status_check CHECK ((status = ANY (ARRAY['대기중'::text, '검토중'::text, '개선중'::text, '개선완료'::text, '반려'::text]))),
    CONSTRAINT suggestion_posts_title_check CHECK ((char_length(btrim(title)) > 0))
);


--
-- Name: system_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_settings (
    key text NOT NULL,
    value text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: task_assignees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_assignees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    description text,
    status text DEFAULT '할 일'::text NOT NULL,
    priority text DEFAULT '보통'::text NOT NULL,
    assigned_to uuid,
    due_date date,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    sort_order integer DEFAULT 0 NOT NULL,
    project_id uuid,
    start_date date,
    estimated_minutes integer,
    actual_minutes integer,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    slack_thread_ts text,
    CONSTRAINT tasks_priority_check CHECK ((priority = ANY (ARRAY['높음'::text, '보통'::text, '낮음'::text]))),
    CONSTRAINT tasks_status_check CHECK ((status = ANY (ARRAY['백로그'::text, '할 일'::text, '진행중'::text, '완료'::text, '취소'::text])))
);


--
-- Name: weekly_meeting_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.weekly_meeting_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    weekly_meeting_id uuid NOT NULL,
    author_employee_id uuid,
    author_name text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT weekly_meeting_comments_content_check CHECK ((char_length(btrim(content)) > 0))
);


--
-- Name: weekly_meetings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.weekly_meetings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    week_start_date date NOT NULL,
    progress_this_week text NOT NULL,
    plans_next_week text NOT NULL,
    blockers text DEFAULT ''::text NOT NULL,
    author_employee_id uuid,
    author_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT weekly_meetings_plans_next_week_check CHECK ((char_length(btrim(plans_next_week)) > 0)),
    CONSTRAINT weekly_meetings_progress_this_week_check CHECK ((char_length(btrim(progress_this_week)) > 0))
);


--
-- Name: app_users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users ALTER COLUMN id SET DEFAULT nextval('public.app_users_id_seq'::regclass);


--
-- Name: settlement_data id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_data ALTER COLUMN id SET DEFAULT nextval('public.settlement_data_id_seq'::regclass);


--
-- Name: _meeting_started_at_backfill_20260413 _meeting_started_at_backfill_20260413_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._meeting_started_at_backfill_20260413
    ADD CONSTRAINT _meeting_started_at_backfill_20260413_pkey PRIMARY KEY (meeting_id);


--
-- Name: agent_memories agent_memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_memories
    ADD CONSTRAINT agent_memories_pkey PRIMARY KEY (id);


--
-- Name: agent_memories agent_memories_user_auth_uid_namespace_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_memories
    ADD CONSTRAINT agent_memories_user_auth_uid_namespace_key_key UNIQUE (user_auth_uid, namespace, key);


--
-- Name: api_keys api_keys_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: app_logs app_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_logs
    ADD CONSTRAINT app_logs_pkey PRIMARY KEY (id);


--
-- Name: app_users app_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_pkey PRIMARY KEY (id);


--
-- Name: app_users app_users_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_user_id_key UNIQUE (user_id);


--
-- Name: business_cards business_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_cards
    ADD CONSTRAINT business_cards_pkey PRIMARY KEY (id);


--
-- Name: card_transactions card_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_transactions
    ADD CONSTRAINT card_transactions_pkey PRIMARY KEY (id);


--
-- Name: chat_usage_logs chat_usage_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_usage_logs
    ADD CONSTRAINT chat_usage_logs_pkey PRIMARY KEY (id);


--
-- Name: contract_audit_logs contract_audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_audit_logs
    ADD CONSTRAINT contract_audit_logs_pkey PRIMARY KEY (id);


--
-- Name: contract_templates contract_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_templates
    ADD CONSTRAINT contract_templates_pkey PRIMARY KEY (id);


--
-- Name: contracts contracts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_pkey PRIMARY KEY (id);


--
-- Name: corporate_cards corporate_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corporate_cards
    ADD CONSTRAINT corporate_cards_pkey PRIMARY KEY (id);


--
-- Name: customer_contacts customer_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_contacts
    ADD CONSTRAINT customer_contacts_pkey PRIMARY KEY (id);


--
-- Name: customer_notes customer_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_notes
    ADD CONSTRAINT customer_notes_pkey PRIMARY KEY (id);


--
-- Name: customers customers_business_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_business_number_key UNIQUE (business_number);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: deposits deposits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deposits
    ADD CONSTRAINT deposits_pkey PRIMARY KEY (id);


--
-- Name: employees employees_login_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_login_id_key UNIQUE (login_id);


--
-- Name: employees employees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_pkey PRIMARY KEY (id);


--
-- Name: expense_status_history expense_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_status_history
    ADD CONSTRAINT expense_status_history_pkey PRIMARY KEY (id);


--
-- Name: expense_types expense_types_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_types
    ADD CONSTRAINT expense_types_name_key UNIQUE (name);


--
-- Name: expense_types expense_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_types
    ADD CONSTRAINT expense_types_pkey PRIMARY KEY (id);


--
-- Name: expenses expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_pkey PRIMARY KEY (id);


--
-- Name: gemini_usage_logs gemini_usage_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gemini_usage_logs
    ADD CONSTRAINT gemini_usage_logs_pkey PRIMARY KEY (id);


--
-- Name: google_calendar_sync_states google_calendar_sync_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_calendar_sync_states
    ADD CONSTRAINT google_calendar_sync_states_pkey PRIMARY KEY (calendar_id);


--
-- Name: google_oauth_tokens google_oauth_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_oauth_tokens
    ADD CONSTRAINT google_oauth_tokens_pkey PRIMARY KEY (id);


--
-- Name: google_oauth_tokens google_oauth_tokens_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_oauth_tokens
    ADD CONSTRAINT google_oauth_tokens_user_id_key UNIQUE (user_id);


--
-- Name: lead_comments lead_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_comments
    ADD CONSTRAINT lead_comments_pkey PRIMARY KEY (id);


--
-- Name: leads leads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_pkey PRIMARY KEY (id);


--
-- Name: meetings meetings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_pkey PRIMARY KEY (id);


--
-- Name: notes notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_pkey PRIMARY KEY (id);


--
-- Name: notification_filters notification_filters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_filters
    ADD CONSTRAINT notification_filters_pkey PRIMARY KEY (id);


--
-- Name: project_assignees project_assignees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_assignees
    ADD CONSTRAINT project_assignees_pkey PRIMARY KEY (id);


--
-- Name: project_assignees project_assignees_project_id_employee_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_assignees
    ADD CONSTRAINT project_assignees_project_id_employee_id_key UNIQUE (project_id, employee_id);


--
-- Name: project_notes project_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_notes
    ADD CONSTRAINT project_notes_pkey PRIMARY KEY (id);


--
-- Name: project_types project_types_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_types
    ADD CONSTRAINT project_types_name_key UNIQUE (name);


--
-- Name: project_types project_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_types
    ADD CONSTRAINT project_types_pkey PRIMARY KEY (id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: projects projects_project_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_project_number_key UNIQUE (project_number);


--
-- Name: quotation_items quotation_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_items
    ADD CONSTRAINT quotation_items_pkey PRIMARY KEY (id);


--
-- Name: quotations quotations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotations
    ADD CONSTRAINT quotations_pkey PRIMARY KEY (id);


--
-- Name: quotations quotations_quotation_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotations
    ADD CONSTRAINT quotations_quotation_number_key UNIQUE (quotation_number);


--
-- Name: recurring_expenses recurring_expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_expenses
    ADD CONSTRAINT recurring_expenses_pkey PRIMARY KEY (id);


--
-- Name: resource_library_posts resource_library_posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_library_posts
    ADD CONSTRAINT resource_library_posts_pkey PRIMARY KEY (id);


--
-- Name: revenues revenues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenues
    ADD CONSTRAINT revenues_pkey PRIMARY KEY (id);


--
-- Name: schedule_attendees schedule_attendees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_attendees
    ADD CONSTRAINT schedule_attendees_pkey PRIMARY KEY (id);


--
-- Name: schedule_attendees schedule_attendees_schedule_id_employee_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_attendees
    ADD CONSTRAINT schedule_attendees_schedule_id_employee_id_key UNIQUE (schedule_id, employee_id);


--
-- Name: schedule_categories schedule_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_categories
    ADD CONSTRAINT schedule_categories_pkey PRIMARY KEY (id);


--
-- Name: schedule_categories schedule_categories_value_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_categories
    ADD CONSTRAINT schedule_categories_value_key UNIQUE (value);


--
-- Name: schedules schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_pkey PRIMARY KEY (id);


--
-- Name: settlement_data settlement_data_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_data
    ADD CONSTRAINT settlement_data_pkey PRIMARY KEY (id);


--
-- Name: slack_pending_actions slack_pending_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_pending_actions
    ADD CONSTRAINT slack_pending_actions_pkey PRIMARY KEY (id);


--
-- Name: sms_logs sms_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_logs
    ADD CONSTRAINT sms_logs_pkey PRIMARY KEY (id);


--
-- Name: sms_templates sms_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_templates
    ADD CONSTRAINT sms_templates_pkey PRIMARY KEY (code);


--
-- Name: suggestion_comments suggestion_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suggestion_comments
    ADD CONSTRAINT suggestion_comments_pkey PRIMARY KEY (id);


--
-- Name: suggestion_posts suggestion_posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suggestion_posts
    ADD CONSTRAINT suggestion_posts_pkey PRIMARY KEY (id);


--
-- Name: system_settings system_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_pkey PRIMARY KEY (key);


--
-- Name: task_assignees task_assignees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_assignees
    ADD CONSTRAINT task_assignees_pkey PRIMARY KEY (id);


--
-- Name: task_assignees task_assignees_task_id_employee_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_assignees
    ADD CONSTRAINT task_assignees_task_id_employee_id_key UNIQUE (task_id, employee_id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: weekly_meeting_comments weekly_meeting_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weekly_meeting_comments
    ADD CONSTRAINT weekly_meeting_comments_pkey PRIMARY KEY (id);


--
-- Name: weekly_meetings weekly_meetings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weekly_meetings
    ADD CONSTRAINT weekly_meetings_pkey PRIMARY KEY (id);


--
-- Name: idx_agent_memories_user_namespace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_memories_user_namespace ON public.agent_memories USING btree (user_auth_uid, namespace);


--
-- Name: idx_api_keys_name_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_name_active ON public.api_keys USING btree (name, is_active);


--
-- Name: idx_app_logs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_logs_created_at ON public.app_logs USING btree (created_at DESC);


--
-- Name: idx_app_logs_level; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_logs_level ON public.app_logs USING btree (level);


--
-- Name: idx_business_cards_company_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_business_cards_company_name ON public.business_cards USING btree (company_name);


--
-- Name: idx_business_cards_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_business_cards_created_at ON public.business_cards USING btree (created_at DESC);


--
-- Name: idx_business_cards_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_business_cards_email ON public.business_cards USING btree (email);


--
-- Name: idx_business_cards_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_business_cards_name ON public.business_cards USING btree (name);


--
-- Name: idx_business_cards_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_business_cards_phone ON public.business_cards USING btree (phone);


--
-- Name: idx_card_tx_approved_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_card_tx_approved_at ON public.card_transactions USING btree (approved_at DESC);


--
-- Name: idx_card_tx_card_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_card_tx_card_id ON public.card_transactions USING btree (card_id);


--
-- Name: idx_card_tx_expense_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_card_tx_expense_id ON public.card_transactions USING btree (expense_id) WHERE (expense_id IS NOT NULL);


--
-- Name: idx_card_tx_is_cancellation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_card_tx_is_cancellation ON public.card_transactions USING btree (is_cancellation) WHERE (is_cancellation = true);


--
-- Name: idx_card_tx_paired_transaction_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_card_tx_paired_transaction_id ON public.card_transactions USING btree (paired_transaction_id) WHERE (paired_transaction_id IS NOT NULL);


--
-- Name: idx_card_tx_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_card_tx_status ON public.card_transactions USING btree (status);


--
-- Name: idx_card_tx_type_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_card_tx_type_id ON public.card_transactions USING btree (type_id) WHERE (type_id IS NOT NULL);


--
-- Name: idx_chat_usage_logs_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_usage_logs_created ON public.chat_usage_logs USING btree (created_at DESC);


--
-- Name: idx_chat_usage_logs_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_usage_logs_source ON public.chat_usage_logs USING btree (source);


--
-- Name: idx_chat_usage_logs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_usage_logs_user ON public.chat_usage_logs USING btree (user_auth_uid);


--
-- Name: idx_contract_audit_logs_contract_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contract_audit_logs_contract_id ON public.contract_audit_logs USING btree (contract_id);


--
-- Name: idx_contract_audit_logs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contract_audit_logs_created_at ON public.contract_audit_logs USING btree (created_at DESC);


--
-- Name: idx_contracts_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contracts_customer_id ON public.contracts USING btree (customer_id);


--
-- Name: idx_contracts_sign_token; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_contracts_sign_token ON public.contracts USING btree (sign_token) WHERE (sign_token IS NOT NULL);


--
-- Name: idx_contracts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contracts_status ON public.contracts USING btree (status);


--
-- Name: idx_corporate_cards_holder; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_corporate_cards_holder ON public.corporate_cards USING btree (holder_employee_id);


--
-- Name: idx_customer_contacts_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_contacts_customer_id ON public.customer_contacts USING btree (customer_id);


--
-- Name: idx_customer_notes_customer_id_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_notes_customer_id_created_at ON public.customer_notes USING btree (customer_id, created_at DESC);


--
-- Name: idx_customers_is_vendor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customers_is_vendor ON public.customers USING btree (is_vendor) WHERE (is_vendor = true);


--
-- Name: idx_employees_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employees_is_active ON public.employees USING btree (is_active);


--
-- Name: idx_employees_login_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employees_login_id ON public.employees USING btree (login_id);


--
-- Name: idx_expense_status_history_expense_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expense_status_history_expense_id ON public.expense_status_history USING btree (expense_id, created_at DESC);


--
-- Name: idx_expenses_card_tx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_card_tx ON public.expenses USING btree (card_transaction_id) WHERE (card_transaction_id IS NOT NULL);


--
-- Name: idx_expenses_payment_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_payment_date ON public.expenses USING btree (payment_date);


--
-- Name: idx_expenses_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_project_id ON public.expenses USING btree (project_id);


--
-- Name: idx_expenses_purchase_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_purchase_date ON public.expenses USING btree (purchase_date);


--
-- Name: idx_expenses_recurring; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_recurring ON public.expenses USING btree (recurring_expense_id) WHERE (recurring_expense_id IS NOT NULL);


--
-- Name: idx_expenses_revenue_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_revenue_id ON public.expenses USING btree (revenue_id);


--
-- Name: idx_expenses_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_source ON public.expenses USING btree (source);


--
-- Name: idx_expenses_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_status ON public.expenses USING btree (status);


--
-- Name: idx_expenses_type_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_type_id ON public.expenses USING btree (type_id);


--
-- Name: idx_expenses_vendor_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_vendor_id ON public.expenses USING btree (vendor_id);


--
-- Name: idx_gemini_usage_logs_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gemini_usage_logs_created ON public.gemini_usage_logs USING btree (created_at DESC);


--
-- Name: idx_gemini_usage_logs_feature; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gemini_usage_logs_feature ON public.gemini_usage_logs USING btree (feature);


--
-- Name: idx_gemini_usage_logs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gemini_usage_logs_user ON public.gemini_usage_logs USING btree (user_auth_uid);


--
-- Name: idx_google_oauth_tokens_one_global; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_google_oauth_tokens_one_global ON public.google_oauth_tokens USING btree (is_global) WHERE (is_global = true);


--
-- Name: idx_lead_comments_lead_id_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lead_comments_lead_id_created_at ON public.lead_comments USING btree (lead_id, created_at DESC);


--
-- Name: idx_leads_assigned_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leads_assigned_to ON public.leads USING btree (assigned_to);


--
-- Name: idx_leads_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leads_customer_id ON public.leads USING btree (customer_id);


--
-- Name: idx_leads_lead_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leads_lead_type ON public.leads USING btree (lead_type);


--
-- Name: idx_leads_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leads_status ON public.leads USING btree (status);


--
-- Name: idx_meetings_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meetings_customer_id ON public.meetings USING btree (customer_id);


--
-- Name: idx_meetings_lead_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meetings_lead_id ON public.meetings USING btree (lead_id);


--
-- Name: idx_notes_author_employee_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notes_author_employee_id ON public.notes USING btree (author_employee_id) WHERE (author_employee_id IS NOT NULL);


--
-- Name: idx_notes_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notes_created_at ON public.notes USING btree (created_at DESC);


--
-- Name: idx_notes_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notes_customer_id ON public.notes USING btree (customer_id) WHERE (customer_id IS NOT NULL);


--
-- Name: idx_notes_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notes_project_id ON public.notes USING btree (project_id) WHERE (project_id IS NOT NULL);


--
-- Name: idx_notes_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notes_search ON public.notes USING gin (to_tsvector('simple'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(content, ''::text))));


--
-- Name: idx_project_assignees_employee_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_assignees_employee_id ON public.project_assignees USING btree (employee_id);


--
-- Name: idx_project_assignees_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_assignees_project_id ON public.project_assignees USING btree (project_id);


--
-- Name: idx_project_notes_project_id_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_notes_project_id_created_at ON public.project_notes USING btree (project_id, created_at DESC);


--
-- Name: idx_projects_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_projects_customer_id ON public.projects USING btree (customer_id);


--
-- Name: idx_quotation_items_quotation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotation_items_quotation_id ON public.quotation_items USING btree (quotation_id);


--
-- Name: idx_quotations_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotations_customer_id ON public.quotations USING btree (customer_id);


--
-- Name: idx_quotations_parent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotations_parent_id ON public.quotations USING btree (parent_id);


--
-- Name: idx_quotations_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotations_project_id ON public.quotations USING btree (project_id);


--
-- Name: idx_quotations_quotation_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotations_quotation_date ON public.quotations USING btree (quotation_date);


--
-- Name: idx_quotations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotations_status ON public.quotations USING btree (status);


--
-- Name: idx_recurring_expenses_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recurring_expenses_active ON public.recurring_expenses USING btree (is_active, day_of_month) WHERE (is_active = true);


--
-- Name: idx_recurring_expenses_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recurring_expenses_type ON public.recurring_expenses USING btree (type_id);


--
-- Name: idx_resource_library_posts_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_resource_library_posts_created_at ON public.resource_library_posts USING btree (created_at DESC);


--
-- Name: idx_revenues_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_revenues_channel ON public.revenues USING btree (channel);


--
-- Name: idx_revenues_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_revenues_project_id ON public.revenues USING btree (project_id);


--
-- Name: idx_revenues_tax_invoice_client_reference_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_revenues_tax_invoice_client_reference_id ON public.revenues USING btree (tax_invoice_client_reference_id) WHERE (tax_invoice_client_reference_id IS NOT NULL);


--
-- Name: idx_revenues_tax_invoice_issuance_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_revenues_tax_invoice_issuance_key ON public.revenues USING btree (tax_invoice_issuance_key) WHERE (tax_invoice_issuance_key IS NOT NULL);


--
-- Name: idx_revenues_tax_invoice_issue_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_revenues_tax_invoice_issue_status ON public.revenues USING btree (tax_invoice_issue_status);


--
-- Name: idx_schedule_attendees_employee_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedule_attendees_employee_id ON public.schedule_attendees USING btree (employee_id);


--
-- Name: idx_schedule_attendees_schedule_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedule_attendees_schedule_id ON public.schedule_attendees USING btree (schedule_id);


--
-- Name: idx_schedules_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedules_created_by ON public.schedules USING btree (created_by);


--
-- Name: idx_schedules_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedules_customer_id ON public.schedules USING btree (customer_id);


--
-- Name: idx_schedules_end_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedules_end_at ON public.schedules USING btree (end_at);


--
-- Name: idx_schedules_google_event_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_schedules_google_event_unique ON public.schedules USING btree (google_calendar_id, google_event_id);


--
-- Name: idx_schedules_lead_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedules_lead_id ON public.schedules USING btree (lead_id);


--
-- Name: idx_schedules_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedules_project_id ON public.schedules USING btree (project_id);


--
-- Name: idx_schedules_recurrence_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedules_recurrence_group ON public.schedules USING btree (recurrence_group_id) WHERE (recurrence_group_id IS NOT NULL);


--
-- Name: idx_schedules_slack_reminder_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedules_slack_reminder_pending ON public.schedules USING btree (start_at) WHERE ((slack_reminder_sent_at IS NULL) AND (all_day = false));


--
-- Name: idx_schedules_start_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedules_start_at ON public.schedules USING btree (start_at);


--
-- Name: idx_sms_logs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_logs_created_at ON public.sms_logs USING btree (created_at DESC);


--
-- Name: idx_sms_logs_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_logs_customer_id ON public.sms_logs USING btree (customer_id);


--
-- Name: idx_sms_logs_expense_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_logs_expense_id ON public.sms_logs USING btree (expense_id);


--
-- Name: idx_suggestion_comments_suggestion_id_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suggestion_comments_suggestion_id_created_at ON public.suggestion_comments USING btree (suggestion_id, created_at DESC);


--
-- Name: idx_suggestion_posts_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suggestion_posts_created_at ON public.suggestion_posts USING btree (created_at DESC);


--
-- Name: idx_task_assignees_employee_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_assignees_employee_id ON public.task_assignees USING btree (employee_id);


--
-- Name: idx_task_assignees_task_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_assignees_task_id ON public.task_assignees USING btree (task_id);


--
-- Name: idx_tasks_date_range; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_date_range ON public.tasks USING btree (start_date, due_date);


--
-- Name: idx_tasks_due_date_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_due_date_status ON public.tasks USING btree (due_date, status) WHERE (status <> ALL (ARRAY['완료'::text, '취소'::text]));


--
-- Name: idx_tasks_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_project_id ON public.tasks USING btree (project_id);


--
-- Name: idx_tasks_sort_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_sort_order ON public.tasks USING btree (sort_order);


--
-- Name: idx_tasks_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_started_at ON public.tasks USING btree (started_at) WHERE (started_at IS NOT NULL);


--
-- Name: idx_weekly_meeting_comments_meeting_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_weekly_meeting_comments_meeting_created ON public.weekly_meeting_comments USING btree (weekly_meeting_id, created_at);


--
-- Name: idx_weekly_meetings_week_start_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_weekly_meetings_week_start_date ON public.weekly_meetings USING btree (week_start_date DESC);


--
-- Name: notification_filters_phrase_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX notification_filters_phrase_unique ON public.notification_filters USING btree (lower(phrase));


--
-- Name: slack_pending_actions_confirmation_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX slack_pending_actions_confirmation_ts_idx ON public.slack_pending_actions USING btree (confirmation_ts);


--
-- Name: slack_pending_actions_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX slack_pending_actions_expires_at_idx ON public.slack_pending_actions USING btree (expires_at) WHERE ((executed_at IS NULL) AND (cancelled_at IS NULL));


--
-- Name: uq_corporate_cards_active_last4; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_corporate_cards_active_last4 ON public.corporate_cards USING btree (last4) WHERE (is_active = true);


--
-- Name: ux_weekly_meetings_week_author; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_weekly_meetings_week_author ON public.weekly_meetings USING btree (week_start_date, author_employee_id) WHERE (author_employee_id IS NOT NULL);


--
-- Name: agent_memories agent_memories_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER agent_memories_updated_at BEFORE UPDATE ON public.agent_memories FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: api_keys api_keys_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER api_keys_updated_at BEFORE UPDATE ON public.api_keys FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: business_cards business_cards_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER business_cards_updated_at BEFORE UPDATE ON public.business_cards FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: customer_notes customer_notes_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER customer_notes_updated_at BEFORE UPDATE ON public.customer_notes FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: customers customers_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER customers_updated_at BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: employees employees_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER employees_updated_at BEFORE UPDATE ON public.employees FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: google_calendar_sync_states google_calendar_sync_states_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER google_calendar_sync_states_updated_at BEFORE UPDATE ON public.google_calendar_sync_states FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: meetings meetings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER meetings_updated_at BEFORE UPDATE ON public.meetings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: project_notes project_notes_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER project_notes_updated_at BEFORE UPDATE ON public.project_notes FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: projects projects_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER projects_updated_at BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: resource_library_posts resource_library_posts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER resource_library_posts_updated_at BEFORE UPDATE ON public.resource_library_posts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: revenues revenues_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER revenues_updated_at BEFORE UPDATE ON public.revenues FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: schedules schedules_reset_slack_reminder_sent_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER schedules_reset_slack_reminder_sent_at BEFORE UPDATE ON public.schedules FOR EACH ROW EXECUTE FUNCTION public.reset_schedule_slack_reminder_sent_at();


--
-- Name: schedules schedules_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER schedules_updated_at BEFORE UPDATE ON public.schedules FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: card_transactions set_card_transactions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_card_transactions_updated_at BEFORE UPDATE ON public.card_transactions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: contract_templates set_contract_templates_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_contract_templates_updated_at BEFORE UPDATE ON public.contract_templates FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: contracts set_contracts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_contracts_updated_at BEFORE UPDATE ON public.contracts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: corporate_cards set_corporate_cards_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_corporate_cards_updated_at BEFORE UPDATE ON public.corporate_cards FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: customer_contacts set_customer_contacts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_customer_contacts_updated_at BEFORE UPDATE ON public.customer_contacts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: deposits set_deposits_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_deposits_updated_at BEFORE UPDATE ON public.deposits FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: expenses set_expenses_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_expenses_updated_at BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: leads set_leads_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_leads_updated_at BEFORE UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: notes set_notes_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_notes_updated_at BEFORE UPDATE ON public.notes FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: quotation_items set_quotation_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_quotation_items_updated_at BEFORE UPDATE ON public.quotation_items FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: quotations set_quotations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_quotations_updated_at BEFORE UPDATE ON public.quotations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: recurring_expenses set_recurring_expenses_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_recurring_expenses_updated_at BEFORE UPDATE ON public.recurring_expenses FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: sms_templates sms_templates_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sms_templates_updated_at BEFORE UPDATE ON public.sms_templates FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: suggestion_posts suggestion_posts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER suggestion_posts_updated_at BEFORE UPDATE ON public.suggestion_posts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: deposits sync_revenue_paid_from_deposit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sync_revenue_paid_from_deposit BEFORE INSERT OR UPDATE ON public.deposits FOR EACH ROW EXECUTE FUNCTION public.sync_revenue_paid_from_deposit();


--
-- Name: tasks tasks_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tasks_updated_at BEFORE UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: google_oauth_tokens trg_google_oauth_tokens_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_google_oauth_tokens_updated_at BEFORE UPDATE ON public.google_oauth_tokens FOR EACH ROW EXECUTE FUNCTION public.update_google_oauth_tokens_updated_at();


--
-- Name: weekly_meetings weekly_meetings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER weekly_meetings_updated_at BEFORE UPDATE ON public.weekly_meetings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: _meeting_started_at_backfill_20260413 _meeting_started_at_backfill_20260413_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._meeting_started_at_backfill_20260413
    ADD CONSTRAINT _meeting_started_at_backfill_20260413_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: app_users app_users_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);


--
-- Name: business_cards business_cards_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_cards
    ADD CONSTRAINT business_cards_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: card_transactions card_transactions_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_transactions
    ADD CONSTRAINT card_transactions_card_id_fkey FOREIGN KEY (card_id) REFERENCES public.corporate_cards(id) ON DELETE SET NULL;


--
-- Name: card_transactions card_transactions_expense_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_transactions
    ADD CONSTRAINT card_transactions_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES public.expenses(id) ON DELETE SET NULL;


--
-- Name: card_transactions card_transactions_paired_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_transactions
    ADD CONSTRAINT card_transactions_paired_transaction_id_fkey FOREIGN KEY (paired_transaction_id) REFERENCES public.card_transactions(id) ON DELETE SET NULL;


--
-- Name: card_transactions card_transactions_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_transactions
    ADD CONSTRAINT card_transactions_type_id_fkey FOREIGN KEY (type_id) REFERENCES public.expense_types(id) ON DELETE SET NULL;


--
-- Name: contract_audit_logs contract_audit_logs_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_audit_logs
    ADD CONSTRAINT contract_audit_logs_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE CASCADE;


--
-- Name: contracts contracts_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: contracts contracts_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: contracts contracts_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.contract_templates(id) ON DELETE SET NULL;


--
-- Name: corporate_cards corporate_cards_holder_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corporate_cards
    ADD CONSTRAINT corporate_cards_holder_employee_id_fkey FOREIGN KEY (holder_employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: customer_contacts customer_contacts_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_contacts
    ADD CONSTRAINT customer_contacts_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: customer_notes customer_notes_author_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_notes
    ADD CONSTRAINT customer_notes_author_employee_id_fkey FOREIGN KEY (author_employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: customer_notes customer_notes_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_notes
    ADD CONSTRAINT customer_notes_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: deposits deposits_revenue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deposits
    ADD CONSTRAINT deposits_revenue_id_fkey FOREIGN KEY (revenue_id) REFERENCES public.revenues(id) ON DELETE SET NULL;


--
-- Name: employees employees_focused_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_focused_task_id_fkey FOREIGN KEY (focused_task_id) REFERENCES public.tasks(id) ON DELETE SET NULL;


--
-- Name: expense_status_history expense_status_history_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_status_history
    ADD CONSTRAINT expense_status_history_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: expense_status_history expense_status_history_expense_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_status_history
    ADD CONSTRAINT expense_status_history_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES public.expenses(id) ON DELETE CASCADE;


--
-- Name: expenses expenses_approver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_approver_id_fkey FOREIGN KEY (approver_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_card_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_card_transaction_id_fkey FOREIGN KEY (card_transaction_id) REFERENCES public.card_transactions(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_recurring_expense_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_recurring_expense_id_fkey FOREIGN KEY (recurring_expense_id) REFERENCES public.recurring_expenses(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_revenue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_revenue_id_fkey FOREIGN KEY (revenue_id) REFERENCES public.revenues(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_type_id_fkey FOREIGN KEY (type_id) REFERENCES public.expense_types(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: google_calendar_sync_states google_calendar_sync_states_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_calendar_sync_states
    ADD CONSTRAINT google_calendar_sync_states_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: google_oauth_tokens google_oauth_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_oauth_tokens
    ADD CONSTRAINT google_oauth_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: lead_comments lead_comments_author_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_comments
    ADD CONSTRAINT lead_comments_author_employee_id_fkey FOREIGN KEY (author_employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: lead_comments lead_comments_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_comments
    ADD CONSTRAINT lead_comments_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE CASCADE;


--
-- Name: leads leads_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: leads leads_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: meetings meetings_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: meetings meetings_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE SET NULL;


--
-- Name: meetings meetings_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: notes notes_author_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_author_employee_id_fkey FOREIGN KEY (author_employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: notes notes_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: notes notes_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: project_assignees project_assignees_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_assignees
    ADD CONSTRAINT project_assignees_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: project_assignees project_assignees_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_assignees
    ADD CONSTRAINT project_assignees_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: project_notes project_notes_author_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_notes
    ADD CONSTRAINT project_notes_author_employee_id_fkey FOREIGN KEY (author_employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: project_notes project_notes_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_notes
    ADD CONSTRAINT project_notes_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: projects projects_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: projects projects_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_type_id_fkey FOREIGN KEY (type_id) REFERENCES public.project_types(id) ON DELETE SET NULL;


--
-- Name: quotation_items quotation_items_quotation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_items
    ADD CONSTRAINT quotation_items_quotation_id_fkey FOREIGN KEY (quotation_id) REFERENCES public.quotations(id) ON DELETE CASCADE;


--
-- Name: quotations quotations_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotations
    ADD CONSTRAINT quotations_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: quotations quotations_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotations
    ADD CONSTRAINT quotations_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.quotations(id) ON DELETE SET NULL;


--
-- Name: quotations quotations_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotations
    ADD CONSTRAINT quotations_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: recurring_expenses recurring_expenses_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_expenses
    ADD CONSTRAINT recurring_expenses_type_id_fkey FOREIGN KEY (type_id) REFERENCES public.expense_types(id) ON DELETE SET NULL;


--
-- Name: recurring_expenses recurring_expenses_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_expenses
    ADD CONSTRAINT recurring_expenses_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: resource_library_posts resource_library_posts_author_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_library_posts
    ADD CONSTRAINT resource_library_posts_author_employee_id_fkey FOREIGN KEY (author_employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: revenues revenues_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenues
    ADD CONSTRAINT revenues_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: revenues revenues_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenues
    ADD CONSTRAINT revenues_type_id_fkey FOREIGN KEY (type_id) REFERENCES public.project_types(id) ON DELETE SET NULL;


--
-- Name: schedule_attendees schedule_attendees_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_attendees
    ADD CONSTRAINT schedule_attendees_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: schedule_attendees schedule_attendees_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_attendees
    ADD CONSTRAINT schedule_attendees_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES public.schedules(id) ON DELETE CASCADE;


--
-- Name: schedules schedules_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: schedules schedules_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: schedules schedules_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE SET NULL;


--
-- Name: schedules schedules_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: settlement_data settlement_data_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_data
    ADD CONSTRAINT settlement_data_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES auth.users(id);


--
-- Name: sms_logs sms_logs_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_logs
    ADD CONSTRAINT sms_logs_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: sms_logs sms_logs_expense_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_logs
    ADD CONSTRAINT sms_logs_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES public.expenses(id) ON DELETE SET NULL;


--
-- Name: sms_logs sms_logs_template_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_logs
    ADD CONSTRAINT sms_logs_template_code_fkey FOREIGN KEY (template_code) REFERENCES public.sms_templates(code) ON DELETE SET NULL;


--
-- Name: suggestion_comments suggestion_comments_author_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suggestion_comments
    ADD CONSTRAINT suggestion_comments_author_employee_id_fkey FOREIGN KEY (author_employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: suggestion_comments suggestion_comments_suggestion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suggestion_comments
    ADD CONSTRAINT suggestion_comments_suggestion_id_fkey FOREIGN KEY (suggestion_id) REFERENCES public.suggestion_posts(id) ON DELETE CASCADE;


--
-- Name: suggestion_posts suggestion_posts_author_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suggestion_posts
    ADD CONSTRAINT suggestion_posts_author_employee_id_fkey FOREIGN KEY (author_employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: task_assignees task_assignees_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_assignees
    ADD CONSTRAINT task_assignees_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: task_assignees task_assignees_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_assignees
    ADD CONSTRAINT task_assignees_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: weekly_meeting_comments weekly_meeting_comments_author_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weekly_meeting_comments
    ADD CONSTRAINT weekly_meeting_comments_author_employee_id_fkey FOREIGN KEY (author_employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: weekly_meeting_comments weekly_meeting_comments_weekly_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weekly_meeting_comments
    ADD CONSTRAINT weekly_meeting_comments_weekly_meeting_id_fkey FOREIGN KEY (weekly_meeting_id) REFERENCES public.weekly_meetings(id) ON DELETE CASCADE;


--
-- Name: weekly_meetings weekly_meetings_author_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weekly_meetings
    ADD CONSTRAINT weekly_meetings_author_employee_id_fkey FOREIGN KEY (author_employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: settlement_data Admin can delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin can delete" ON public.settlement_data FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.app_users
  WHERE ((app_users.user_id = auth.uid()) AND (app_users.role = 'admin'::text)))));


--
-- Name: settlement_data Admin can insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin can insert" ON public.settlement_data FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.app_users
  WHERE ((app_users.user_id = auth.uid()) AND (app_users.role = 'admin'::text)))));


--
-- Name: settlement_data Authenticated can read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated can read" ON public.settlement_data FOR SELECT TO authenticated USING (true);


--
-- Name: api_keys Authenticated users can delete api_keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete api_keys" ON public.api_keys FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: business_cards Authenticated users can delete business_cards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete business_cards" ON public.business_cards FOR DELETE TO authenticated USING (true);


--
-- Name: card_transactions Authenticated users can delete card_transactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete card_transactions" ON public.card_transactions FOR DELETE TO authenticated USING (true);


--
-- Name: corporate_cards Authenticated users can delete corporate_cards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete corporate_cards" ON public.corporate_cards FOR DELETE TO authenticated USING (true);


--
-- Name: customer_notes Authenticated users can delete customer notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete customer notes" ON public.customer_notes FOR DELETE TO authenticated USING (true);


--
-- Name: customers Authenticated users can delete customers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete customers" ON public.customers FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: deposits Authenticated users can delete deposits; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete deposits" ON public.deposits FOR DELETE TO authenticated USING (true);


--
-- Name: employees Authenticated users can delete employees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete employees" ON public.employees FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: expense_types Authenticated users can delete expense_types; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete expense_types" ON public.expense_types FOR DELETE TO authenticated USING (true);


--
-- Name: expenses Authenticated users can delete expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete expenses" ON public.expenses FOR DELETE TO authenticated USING (true);


--
-- Name: google_calendar_sync_states Authenticated users can delete google calendar sync states; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete google calendar sync states" ON public.google_calendar_sync_states FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: lead_comments Authenticated users can delete lead comments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete lead comments" ON public.lead_comments FOR DELETE TO authenticated USING (true);


--
-- Name: leads Authenticated users can delete leads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete leads" ON public.leads FOR DELETE TO authenticated USING (true);


--
-- Name: meetings Authenticated users can delete meetings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete meetings" ON public.meetings FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: project_notes Authenticated users can delete project notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete project notes" ON public.project_notes FOR DELETE TO authenticated USING (true);


--
-- Name: project_assignees Authenticated users can delete project_assignees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete project_assignees" ON public.project_assignees FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: project_types Authenticated users can delete project_types; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete project_types" ON public.project_types FOR DELETE TO authenticated USING (true);


--
-- Name: projects Authenticated users can delete projects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete projects" ON public.projects FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: recurring_expenses Authenticated users can delete recurring_expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete recurring_expenses" ON public.recurring_expenses FOR DELETE TO authenticated USING (true);


--
-- Name: resource_library_posts Authenticated users can delete resource_library_posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete resource_library_posts" ON public.resource_library_posts FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: revenues Authenticated users can delete revenues; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete revenues" ON public.revenues FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: schedule_attendees Authenticated users can delete schedule_attendees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete schedule_attendees" ON public.schedule_attendees FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: schedules Authenticated users can delete schedules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete schedules" ON public.schedules FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: suggestion_comments Authenticated users can delete suggestion comments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete suggestion comments" ON public.suggestion_comments FOR DELETE TO authenticated USING (true);


--
-- Name: suggestion_posts Authenticated users can delete suggestion posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete suggestion posts" ON public.suggestion_posts FOR DELETE TO authenticated USING (true);


--
-- Name: task_assignees Authenticated users can delete task_assignees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete task_assignees" ON public.task_assignees FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: weekly_meeting_comments Authenticated users can delete weekly_meeting_comments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete weekly_meeting_comments" ON public.weekly_meeting_comments FOR DELETE TO authenticated USING (true);


--
-- Name: weekly_meetings Authenticated users can delete weekly_meetings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete weekly_meetings" ON public.weekly_meetings FOR DELETE TO authenticated USING (true);


--
-- Name: api_keys Authenticated users can insert api_keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert api_keys" ON public.api_keys FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: business_cards Authenticated users can insert business_cards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert business_cards" ON public.business_cards FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: card_transactions Authenticated users can insert card_transactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert card_transactions" ON public.card_transactions FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: contract_audit_logs Authenticated users can insert contract_audit_logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert contract_audit_logs" ON public.contract_audit_logs FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: corporate_cards Authenticated users can insert corporate_cards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert corporate_cards" ON public.corporate_cards FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: customer_notes Authenticated users can insert customer notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert customer notes" ON public.customer_notes FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: customers Authenticated users can insert customers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert customers" ON public.customers FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: deposits Authenticated users can insert deposits; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert deposits" ON public.deposits FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: employees Authenticated users can insert employees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert employees" ON public.employees FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: expense_status_history Authenticated users can insert expense_status_history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert expense_status_history" ON public.expense_status_history FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: expense_types Authenticated users can insert expense_types; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert expense_types" ON public.expense_types FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: expenses Authenticated users can insert expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert expenses" ON public.expenses FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: google_calendar_sync_states Authenticated users can insert google calendar sync states; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert google calendar sync states" ON public.google_calendar_sync_states FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: lead_comments Authenticated users can insert lead comments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert lead comments" ON public.lead_comments FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: leads Authenticated users can insert leads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert leads" ON public.leads FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: meetings Authenticated users can insert meetings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert meetings" ON public.meetings FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: chat_usage_logs Authenticated users can insert own chat usage logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert own chat usage logs" ON public.chat_usage_logs FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_auth_uid));


--
-- Name: gemini_usage_logs Authenticated users can insert own gemini usage logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert own gemini usage logs" ON public.gemini_usage_logs FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_auth_uid));


--
-- Name: project_notes Authenticated users can insert project notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert project notes" ON public.project_notes FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: project_assignees Authenticated users can insert project_assignees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert project_assignees" ON public.project_assignees FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: project_types Authenticated users can insert project_types; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert project_types" ON public.project_types FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: projects Authenticated users can insert projects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert projects" ON public.projects FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: recurring_expenses Authenticated users can insert recurring_expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert recurring_expenses" ON public.recurring_expenses FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: resource_library_posts Authenticated users can insert resource_library_posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert resource_library_posts" ON public.resource_library_posts FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: revenues Authenticated users can insert revenues; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert revenues" ON public.revenues FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: schedule_attendees Authenticated users can insert schedule_attendees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert schedule_attendees" ON public.schedule_attendees FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: schedules Authenticated users can insert schedules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert schedules" ON public.schedules FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: sms_logs Authenticated users can insert sms_logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert sms_logs" ON public.sms_logs FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: suggestion_comments Authenticated users can insert suggestion comments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert suggestion comments" ON public.suggestion_comments FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: suggestion_posts Authenticated users can insert suggestion posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert suggestion posts" ON public.suggestion_posts FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: task_assignees Authenticated users can insert task_assignees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert task_assignees" ON public.task_assignees FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: weekly_meeting_comments Authenticated users can insert weekly_meeting_comments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert weekly_meeting_comments" ON public.weekly_meeting_comments FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: weekly_meetings Authenticated users can insert weekly_meetings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert weekly_meetings" ON public.weekly_meetings FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: contract_templates Authenticated users can manage contract_templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can manage contract_templates" ON public.contract_templates TO authenticated USING (true) WITH CHECK (true);


--
-- Name: contracts Authenticated users can manage contracts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can manage contracts" ON public.contracts TO authenticated USING (true) WITH CHECK (true);


--
-- Name: customer_contacts Authenticated users can manage customer_contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can manage customer_contacts" ON public.customer_contacts TO authenticated USING (true) WITH CHECK (true);


--
-- Name: notification_filters Authenticated users can manage notification filters; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can manage notification filters" ON public.notification_filters TO authenticated USING (true) WITH CHECK (true);


--
-- Name: quotation_items Authenticated users can manage quotation_items; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can manage quotation_items" ON public.quotation_items TO authenticated USING (true) WITH CHECK (true);


--
-- Name: quotations Authenticated users can manage quotations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can manage quotations" ON public.quotations TO authenticated USING (true) WITH CHECK (true);


--
-- Name: schedule_categories Authenticated users can manage schedule_categories; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can manage schedule_categories" ON public.schedule_categories TO authenticated USING (true) WITH CHECK (true);


--
-- Name: sms_templates Authenticated users can manage sms_templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can manage sms_templates" ON public.sms_templates TO authenticated USING (true) WITH CHECK (true);


--
-- Name: tasks Authenticated users can manage tasks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can manage tasks" ON public.tasks TO authenticated USING (true) WITH CHECK (true);


--
-- Name: chat_usage_logs Authenticated users can read all chat usage logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read all chat usage logs" ON public.chat_usage_logs FOR SELECT TO authenticated USING (true);


--
-- Name: gemini_usage_logs Authenticated users can read all gemini usage logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read all gemini usage logs" ON public.gemini_usage_logs FOR SELECT TO authenticated USING (true);


--
-- Name: card_transactions Authenticated users can read card_transactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read card_transactions" ON public.card_transactions FOR SELECT TO authenticated USING (true);


--
-- Name: corporate_cards Authenticated users can read corporate_cards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read corporate_cards" ON public.corporate_cards FOR SELECT TO authenticated USING (true);


--
-- Name: deposits Authenticated users can read deposits; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read deposits" ON public.deposits FOR SELECT TO authenticated USING (true);


--
-- Name: expense_status_history Authenticated users can read expense_status_history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read expense_status_history" ON public.expense_status_history FOR SELECT TO authenticated USING (true);


--
-- Name: expense_types Authenticated users can read expense_types; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read expense_types" ON public.expense_types FOR SELECT TO authenticated USING (true);


--
-- Name: expenses Authenticated users can read expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read expenses" ON public.expenses FOR SELECT TO authenticated USING (true);


--
-- Name: notification_filters Authenticated users can read notification filters; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read notification filters" ON public.notification_filters FOR SELECT TO authenticated USING (true);


--
-- Name: agent_memories Authenticated users can read own agent memories; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read own agent memories" ON public.agent_memories FOR SELECT TO authenticated USING ((auth.uid() = user_auth_uid));


--
-- Name: project_types Authenticated users can read project_types; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read project_types" ON public.project_types FOR SELECT TO authenticated USING (true);


--
-- Name: recurring_expenses Authenticated users can read recurring_expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read recurring_expenses" ON public.recurring_expenses FOR SELECT TO authenticated USING (true);


--
-- Name: schedule_categories Authenticated users can read schedule_categories; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read schedule_categories" ON public.schedule_categories FOR SELECT TO authenticated USING (true);


--
-- Name: sms_logs Authenticated users can read sms_logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read sms_logs" ON public.sms_logs FOR SELECT TO authenticated USING (true);


--
-- Name: system_settings Authenticated users can read system settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read system settings" ON public.system_settings FOR SELECT TO authenticated USING (true);


--
-- Name: contract_audit_logs Authenticated users can select contract_audit_logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can select contract_audit_logs" ON public.contract_audit_logs FOR SELECT TO authenticated USING (true);


--
-- Name: customer_notes Authenticated users can select customer notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can select customer notes" ON public.customer_notes FOR SELECT TO authenticated USING (true);


--
-- Name: lead_comments Authenticated users can select lead comments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can select lead comments" ON public.lead_comments FOR SELECT TO authenticated USING (true);


--
-- Name: leads Authenticated users can select leads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can select leads" ON public.leads FOR SELECT TO authenticated USING (true);


--
-- Name: project_notes Authenticated users can select project notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can select project notes" ON public.project_notes FOR SELECT TO authenticated USING (true);


--
-- Name: suggestion_comments Authenticated users can select suggestion comments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can select suggestion comments" ON public.suggestion_comments FOR SELECT TO authenticated USING (true);


--
-- Name: suggestion_posts Authenticated users can select suggestion posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can select suggestion posts" ON public.suggestion_posts FOR SELECT TO authenticated USING (true);


--
-- Name: weekly_meeting_comments Authenticated users can select weekly_meeting_comments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can select weekly_meeting_comments" ON public.weekly_meeting_comments FOR SELECT TO authenticated USING (true);


--
-- Name: weekly_meetings Authenticated users can select weekly_meetings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can select weekly_meetings" ON public.weekly_meetings FOR SELECT TO authenticated USING (true);


--
-- Name: api_keys Authenticated users can update api_keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update api_keys" ON public.api_keys FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: business_cards Authenticated users can update business_cards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update business_cards" ON public.business_cards FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: card_transactions Authenticated users can update card_transactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update card_transactions" ON public.card_transactions FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: corporate_cards Authenticated users can update corporate_cards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update corporate_cards" ON public.corporate_cards FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: customer_notes Authenticated users can update customer notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update customer notes" ON public.customer_notes FOR UPDATE TO authenticated USING (true);


--
-- Name: customers Authenticated users can update customers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update customers" ON public.customers FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: deposits Authenticated users can update deposits; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update deposits" ON public.deposits FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: employees Authenticated users can update employees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update employees" ON public.employees FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: expense_types Authenticated users can update expense_types; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update expense_types" ON public.expense_types FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: expenses Authenticated users can update expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update expenses" ON public.expenses FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: google_calendar_sync_states Authenticated users can update google calendar sync states; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update google calendar sync states" ON public.google_calendar_sync_states FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: lead_comments Authenticated users can update lead comments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update lead comments" ON public.lead_comments FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: leads Authenticated users can update leads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update leads" ON public.leads FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: meetings Authenticated users can update meetings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update meetings" ON public.meetings FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: project_notes Authenticated users can update project notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update project notes" ON public.project_notes FOR UPDATE TO authenticated USING (true);


--
-- Name: project_assignees Authenticated users can update project_assignees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update project_assignees" ON public.project_assignees FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: project_types Authenticated users can update project_types; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update project_types" ON public.project_types FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: projects Authenticated users can update projects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update projects" ON public.projects FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: recurring_expenses Authenticated users can update recurring_expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update recurring_expenses" ON public.recurring_expenses FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: resource_library_posts Authenticated users can update resource_library_posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update resource_library_posts" ON public.resource_library_posts FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: revenues Authenticated users can update revenues; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update revenues" ON public.revenues FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: schedule_attendees Authenticated users can update schedule_attendees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update schedule_attendees" ON public.schedule_attendees FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: schedules Authenticated users can update schedules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update schedules" ON public.schedules FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: suggestion_comments Authenticated users can update suggestion comments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update suggestion comments" ON public.suggestion_comments FOR UPDATE TO authenticated USING (true);


--
-- Name: suggestion_posts Authenticated users can update suggestion posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update suggestion posts" ON public.suggestion_posts FOR UPDATE TO authenticated USING (true);


--
-- Name: task_assignees Authenticated users can update task_assignees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update task_assignees" ON public.task_assignees FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: weekly_meeting_comments Authenticated users can update weekly_meeting_comments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update weekly_meeting_comments" ON public.weekly_meeting_comments FOR UPDATE TO authenticated USING (true);


--
-- Name: weekly_meetings Authenticated users can update weekly_meetings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update weekly_meetings" ON public.weekly_meetings FOR UPDATE TO authenticated USING (true);


--
-- Name: system_settings Authenticated users can upsert system settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can upsert system settings" ON public.system_settings TO authenticated USING (true) WITH CHECK (true);


--
-- Name: api_keys Authenticated users can view api_keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view api_keys" ON public.api_keys FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: business_cards Authenticated users can view business_cards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view business_cards" ON public.business_cards FOR SELECT TO authenticated USING (true);


--
-- Name: customers Authenticated users can view customers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view customers" ON public.customers FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: employees Authenticated users can view employees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view employees" ON public.employees FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: google_calendar_sync_states Authenticated users can view google calendar sync states; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view google calendar sync states" ON public.google_calendar_sync_states FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: meetings Authenticated users can view meetings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view meetings" ON public.meetings FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: project_assignees Authenticated users can view project_assignees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view project_assignees" ON public.project_assignees FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: projects Authenticated users can view projects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view projects" ON public.projects FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: resource_library_posts Authenticated users can view resource_library_posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view resource_library_posts" ON public.resource_library_posts FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: revenues Authenticated users can view revenues; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view revenues" ON public.revenues FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: schedule_attendees Authenticated users can view schedule_attendees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view schedule_attendees" ON public.schedule_attendees FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: schedules Authenticated users can view schedules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view schedules" ON public.schedules FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: task_assignees Authenticated users can view task_assignees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view task_assignees" ON public.task_assignees FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: agent_memories Authenticated users can write own agent memories; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can write own agent memories" ON public.agent_memories TO authenticated USING ((auth.uid() = user_auth_uid)) WITH CHECK ((auth.uid() = user_auth_uid));


--
-- Name: _meeting_started_at_backfill_20260413 No app access to meeting started_at backfill backup; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "No app access to meeting started_at backfill backup" ON public._meeting_started_at_backfill_20260413 TO authenticated, anon USING (false) WITH CHECK (false);


--
-- Name: card_transactions Service role full access on card_transactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full access on card_transactions" ON public.card_transactions TO service_role USING (true) WITH CHECK (true);


--
-- Name: corporate_cards Service role full access on corporate_cards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full access on corporate_cards" ON public.corporate_cards TO service_role USING (true) WITH CHECK (true);


--
-- Name: deposits Service role full access on deposits; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full access on deposits" ON public.deposits TO service_role USING (true) WITH CHECK (true);


--
-- Name: expense_status_history Service role full access on expense_status_history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full access on expense_status_history" ON public.expense_status_history TO service_role USING (true) WITH CHECK (true);


--
-- Name: expenses Service role full access on expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full access on expenses" ON public.expenses TO service_role USING (true) WITH CHECK (true);


--
-- Name: recurring_expenses Service role full access on recurring_expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full access on recurring_expenses" ON public.recurring_expenses TO service_role USING (true) WITH CHECK (true);


--
-- Name: sms_logs Service role full access on sms_logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full access on sms_logs" ON public.sms_logs TO service_role USING (true) WITH CHECK (true);


--
-- Name: sms_templates Service role full access on sms_templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full access on sms_templates" ON public.sms_templates TO service_role USING (true) WITH CHECK (true);


--
-- Name: app_users Users can read own role; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can read own role" ON public.app_users FOR SELECT TO authenticated USING (true);


--
-- Name: _meeting_started_at_backfill_20260413; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public._meeting_started_at_backfill_20260413 ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_memories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_memories ENABLE ROW LEVEL SECURITY;

--
-- Name: api_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: app_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: app_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;

--
-- Name: app_logs auth_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_insert ON public.app_logs FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: app_logs auth_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_select ON public.app_logs FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: business_cards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.business_cards ENABLE ROW LEVEL SECURITY;

--
-- Name: card_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.card_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_usage_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chat_usage_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: contract_audit_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contract_audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: contract_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contract_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: contracts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contracts ENABLE ROW LEVEL SECURITY;

--
-- Name: corporate_cards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.corporate_cards ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customer_contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customer_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: customers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

--
-- Name: deposits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.deposits ENABLE ROW LEVEL SECURITY;

--
-- Name: employees; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;

--
-- Name: expense_status_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expense_status_history ENABLE ROW LEVEL SECURITY;

--
-- Name: expense_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expense_types ENABLE ROW LEVEL SECURITY;

--
-- Name: expenses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

--
-- Name: gemini_usage_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.gemini_usage_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: google_calendar_sync_states; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.google_calendar_sync_states ENABLE ROW LEVEL SECURITY;

--
-- Name: google_oauth_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.google_oauth_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: lead_comments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lead_comments ENABLE ROW LEVEL SECURITY;

--
-- Name: leads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

--
-- Name: meetings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.meetings ENABLE ROW LEVEL SECURITY;

--
-- Name: notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;

--
-- Name: notes notes_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notes_delete ON public.notes FOR DELETE TO authenticated USING (true);


--
-- Name: notes notes_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notes_insert ON public.notes FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: notes notes_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notes_select ON public.notes FOR SELECT TO authenticated USING (true);


--
-- Name: notes notes_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notes_update ON public.notes FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: notification_filters; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_filters ENABLE ROW LEVEL SECURITY;

--
-- Name: project_assignees; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.project_assignees ENABLE ROW LEVEL SECURITY;

--
-- Name: project_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.project_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: project_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.project_types ENABLE ROW LEVEL SECURITY;

--
-- Name: projects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

--
-- Name: quotation_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.quotation_items ENABLE ROW LEVEL SECURITY;

--
-- Name: quotations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.quotations ENABLE ROW LEVEL SECURITY;

--
-- Name: recurring_expenses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.recurring_expenses ENABLE ROW LEVEL SECURITY;

--
-- Name: resource_library_posts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.resource_library_posts ENABLE ROW LEVEL SECURITY;

--
-- Name: revenues; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.revenues ENABLE ROW LEVEL SECURITY;

--
-- Name: schedule_attendees; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.schedule_attendees ENABLE ROW LEVEL SECURITY;

--
-- Name: schedule_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.schedule_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.schedules ENABLE ROW LEVEL SECURITY;

--
-- Name: slack_pending_actions service_role manages slack_pending_actions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service_role manages slack_pending_actions" ON public.slack_pending_actions TO service_role USING (true) WITH CHECK (true);


--
-- Name: settlement_data; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.settlement_data ENABLE ROW LEVEL SECURITY;

--
-- Name: slack_pending_actions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.slack_pending_actions ENABLE ROW LEVEL SECURITY;

--
-- Name: sms_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sms_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: sms_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sms_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: suggestion_comments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.suggestion_comments ENABLE ROW LEVEL SECURITY;

--
-- Name: suggestion_posts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.suggestion_posts ENABLE ROW LEVEL SECURITY;

--
-- Name: system_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: task_assignees; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.task_assignees ENABLE ROW LEVEL SECURITY;

--
-- Name: tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: weekly_meeting_comments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.weekly_meeting_comments ENABLE ROW LEVEL SECURITY;

--
-- Name: weekly_meetings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.weekly_meetings ENABLE ROW LEVEL SECURITY;

--
-- Name: google_oauth_tokens 토큰 삭제; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "토큰 삭제" ON public.google_oauth_tokens FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: google_oauth_tokens 토큰 수정; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "토큰 수정" ON public.google_oauth_tokens FOR UPDATE USING (((auth.uid() = user_id) OR (is_global = true)));


--
-- Name: google_oauth_tokens 토큰 쓰기; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "토큰 쓰기" ON public.google_oauth_tokens FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: google_oauth_tokens 토큰 읽기; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "토큰 읽기" ON public.google_oauth_tokens FOR SELECT USING (((auth.uid() = user_id) OR (is_global = true)));


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--



--
-- Name: FUNCTION generate_project_number(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.generate_project_number() TO anon;
GRANT ALL ON FUNCTION public.generate_project_number() TO authenticated;
GRANT ALL ON FUNCTION public.generate_project_number() TO service_role;


--
-- Name: FUNCTION generate_quotation_number(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.generate_quotation_number() TO anon;
GRANT ALL ON FUNCTION public.generate_quotation_number() TO authenticated;
GRANT ALL ON FUNCTION public.generate_quotation_number() TO service_role;


--
-- Name: FUNCTION normalize_business_name(value text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.normalize_business_name(value text) TO anon;
GRANT ALL ON FUNCTION public.normalize_business_name(value text) TO authenticated;
GRANT ALL ON FUNCTION public.normalize_business_name(value text) TO service_role;


--
-- Name: FUNCTION replace_schedule_attendees_atomic(p_schedule_ids uuid[], p_attendee_ids uuid[], p_actor_employee_id uuid, p_is_admin boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.replace_schedule_attendees_atomic(p_schedule_ids uuid[], p_attendee_ids uuid[], p_actor_employee_id uuid, p_is_admin boolean) TO anon;
GRANT ALL ON FUNCTION public.replace_schedule_attendees_atomic(p_schedule_ids uuid[], p_attendee_ids uuid[], p_actor_employee_id uuid, p_is_admin boolean) TO authenticated;
GRANT ALL ON FUNCTION public.replace_schedule_attendees_atomic(p_schedule_ids uuid[], p_attendee_ids uuid[], p_actor_employee_id uuid, p_is_admin boolean) TO service_role;


--
-- Name: FUNCTION reset_schedule_slack_reminder_sent_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.reset_schedule_slack_reminder_sent_at() TO anon;
GRANT ALL ON FUNCTION public.reset_schedule_slack_reminder_sent_at() TO authenticated;
GRANT ALL ON FUNCTION public.reset_schedule_slack_reminder_sent_at() TO service_role;


--
-- Name: FUNCTION sync_revenue_paid_from_deposit(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.sync_revenue_paid_from_deposit() TO anon;
GRANT ALL ON FUNCTION public.sync_revenue_paid_from_deposit() TO authenticated;
GRANT ALL ON FUNCTION public.sync_revenue_paid_from_deposit() TO service_role;


--
-- Name: FUNCTION update_google_oauth_tokens_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_google_oauth_tokens_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_google_oauth_tokens_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_google_oauth_tokens_updated_at() TO service_role;


--
-- Name: FUNCTION update_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_updated_at() TO service_role;


--
-- Name: FUNCTION update_updated_at_column(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_updated_at_column() TO anon;
GRANT ALL ON FUNCTION public.update_updated_at_column() TO authenticated;
GRANT ALL ON FUNCTION public.update_updated_at_column() TO service_role;


--
-- Name: TABLE _meeting_started_at_backfill_20260413; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public._meeting_started_at_backfill_20260413 TO service_role;


--
-- Name: TABLE agent_memories; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.agent_memories TO anon;
GRANT ALL ON TABLE public.agent_memories TO authenticated;
GRANT ALL ON TABLE public.agent_memories TO service_role;


--
-- Name: TABLE api_keys; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.api_keys TO anon;
GRANT ALL ON TABLE public.api_keys TO authenticated;
GRANT ALL ON TABLE public.api_keys TO service_role;


--
-- Name: TABLE app_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.app_logs TO anon;
GRANT ALL ON TABLE public.app_logs TO authenticated;
GRANT ALL ON TABLE public.app_logs TO service_role;


--
-- Name: TABLE app_users; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.app_users TO anon;
GRANT ALL ON TABLE public.app_users TO authenticated;
GRANT ALL ON TABLE public.app_users TO service_role;


--
-- Name: SEQUENCE app_users_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.app_users_id_seq TO anon;
GRANT ALL ON SEQUENCE public.app_users_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.app_users_id_seq TO service_role;


--
-- Name: TABLE business_cards; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.business_cards TO anon;
GRANT ALL ON TABLE public.business_cards TO authenticated;
GRANT ALL ON TABLE public.business_cards TO service_role;


--
-- Name: TABLE card_transactions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.card_transactions TO anon;
GRANT ALL ON TABLE public.card_transactions TO authenticated;
GRANT ALL ON TABLE public.card_transactions TO service_role;


--
-- Name: TABLE chat_usage_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.chat_usage_logs TO anon;
GRANT ALL ON TABLE public.chat_usage_logs TO authenticated;
GRANT ALL ON TABLE public.chat_usage_logs TO service_role;


--
-- Name: TABLE contract_audit_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.contract_audit_logs TO anon;
GRANT ALL ON TABLE public.contract_audit_logs TO authenticated;
GRANT ALL ON TABLE public.contract_audit_logs TO service_role;


--
-- Name: TABLE contract_templates; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.contract_templates TO anon;
GRANT ALL ON TABLE public.contract_templates TO authenticated;
GRANT ALL ON TABLE public.contract_templates TO service_role;


--
-- Name: TABLE contracts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.contracts TO anon;
GRANT ALL ON TABLE public.contracts TO authenticated;
GRANT ALL ON TABLE public.contracts TO service_role;


--
-- Name: TABLE corporate_cards; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.corporate_cards TO anon;
GRANT ALL ON TABLE public.corporate_cards TO authenticated;
GRANT ALL ON TABLE public.corporate_cards TO service_role;


--
-- Name: TABLE customer_contacts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.customer_contacts TO anon;
GRANT ALL ON TABLE public.customer_contacts TO authenticated;
GRANT ALL ON TABLE public.customer_contacts TO service_role;


--
-- Name: TABLE customer_notes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.customer_notes TO anon;
GRANT ALL ON TABLE public.customer_notes TO authenticated;
GRANT ALL ON TABLE public.customer_notes TO service_role;


--
-- Name: TABLE customers; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.customers TO anon;
GRANT ALL ON TABLE public.customers TO authenticated;
GRANT ALL ON TABLE public.customers TO service_role;


--
-- Name: TABLE deposits; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.deposits TO anon;
GRANT ALL ON TABLE public.deposits TO authenticated;
GRANT ALL ON TABLE public.deposits TO service_role;


--
-- Name: TABLE employees; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.employees TO anon;
GRANT ALL ON TABLE public.employees TO authenticated;
GRANT ALL ON TABLE public.employees TO service_role;


--
-- Name: TABLE expense_status_history; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.expense_status_history TO anon;
GRANT ALL ON TABLE public.expense_status_history TO authenticated;
GRANT ALL ON TABLE public.expense_status_history TO service_role;


--
-- Name: TABLE expense_types; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.expense_types TO anon;
GRANT ALL ON TABLE public.expense_types TO authenticated;
GRANT ALL ON TABLE public.expense_types TO service_role;


--
-- Name: TABLE expenses; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.expenses TO anon;
GRANT ALL ON TABLE public.expenses TO authenticated;
GRANT ALL ON TABLE public.expenses TO service_role;


--
-- Name: TABLE gemini_usage_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.gemini_usage_logs TO anon;
GRANT ALL ON TABLE public.gemini_usage_logs TO authenticated;
GRANT ALL ON TABLE public.gemini_usage_logs TO service_role;


--
-- Name: TABLE google_calendar_sync_states; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.google_calendar_sync_states TO anon;
GRANT ALL ON TABLE public.google_calendar_sync_states TO authenticated;
GRANT ALL ON TABLE public.google_calendar_sync_states TO service_role;


--
-- Name: TABLE google_oauth_tokens; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.google_oauth_tokens TO anon;
GRANT ALL ON TABLE public.google_oauth_tokens TO authenticated;
GRANT ALL ON TABLE public.google_oauth_tokens TO service_role;


--
-- Name: TABLE lead_comments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.lead_comments TO anon;
GRANT ALL ON TABLE public.lead_comments TO authenticated;
GRANT ALL ON TABLE public.lead_comments TO service_role;


--
-- Name: TABLE leads; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.leads TO anon;
GRANT ALL ON TABLE public.leads TO authenticated;
GRANT ALL ON TABLE public.leads TO service_role;


--
-- Name: TABLE meetings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.meetings TO anon;
GRANT ALL ON TABLE public.meetings TO authenticated;
GRANT ALL ON TABLE public.meetings TO service_role;


--
-- Name: TABLE notes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.notes TO anon;
GRANT ALL ON TABLE public.notes TO authenticated;
GRANT ALL ON TABLE public.notes TO service_role;


--
-- Name: TABLE notification_filters; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.notification_filters TO anon;
GRANT ALL ON TABLE public.notification_filters TO authenticated;
GRANT ALL ON TABLE public.notification_filters TO service_role;


--
-- Name: TABLE project_assignees; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.project_assignees TO anon;
GRANT ALL ON TABLE public.project_assignees TO authenticated;
GRANT ALL ON TABLE public.project_assignees TO service_role;


--
-- Name: TABLE project_notes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.project_notes TO anon;
GRANT ALL ON TABLE public.project_notes TO authenticated;
GRANT ALL ON TABLE public.project_notes TO service_role;


--
-- Name: TABLE project_types; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.project_types TO anon;
GRANT ALL ON TABLE public.project_types TO authenticated;
GRANT ALL ON TABLE public.project_types TO service_role;


--
-- Name: TABLE projects; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.projects TO anon;
GRANT ALL ON TABLE public.projects TO authenticated;
GRANT ALL ON TABLE public.projects TO service_role;


--
-- Name: TABLE quotation_items; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.quotation_items TO anon;
GRANT ALL ON TABLE public.quotation_items TO authenticated;
GRANT ALL ON TABLE public.quotation_items TO service_role;


--
-- Name: TABLE quotations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.quotations TO anon;
GRANT ALL ON TABLE public.quotations TO authenticated;
GRANT ALL ON TABLE public.quotations TO service_role;


--
-- Name: TABLE recurring_expenses; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.recurring_expenses TO anon;
GRANT ALL ON TABLE public.recurring_expenses TO authenticated;
GRANT ALL ON TABLE public.recurring_expenses TO service_role;


--
-- Name: TABLE resource_library_posts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.resource_library_posts TO anon;
GRANT ALL ON TABLE public.resource_library_posts TO authenticated;
GRANT ALL ON TABLE public.resource_library_posts TO service_role;


--
-- Name: TABLE revenues; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.revenues TO anon;
GRANT ALL ON TABLE public.revenues TO authenticated;
GRANT ALL ON TABLE public.revenues TO service_role;


--
-- Name: TABLE schedule_attendees; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.schedule_attendees TO anon;
GRANT ALL ON TABLE public.schedule_attendees TO authenticated;
GRANT ALL ON TABLE public.schedule_attendees TO service_role;


--
-- Name: TABLE schedule_categories; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.schedule_categories TO anon;
GRANT ALL ON TABLE public.schedule_categories TO authenticated;
GRANT ALL ON TABLE public.schedule_categories TO service_role;


--
-- Name: TABLE schedules; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.schedules TO anon;
GRANT ALL ON TABLE public.schedules TO authenticated;
GRANT ALL ON TABLE public.schedules TO service_role;


--
-- Name: TABLE settlement_data; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.settlement_data TO anon;
GRANT ALL ON TABLE public.settlement_data TO authenticated;
GRANT ALL ON TABLE public.settlement_data TO service_role;


--
-- Name: SEQUENCE settlement_data_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.settlement_data_id_seq TO anon;
GRANT ALL ON SEQUENCE public.settlement_data_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.settlement_data_id_seq TO service_role;


--
-- Name: TABLE slack_pending_actions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.slack_pending_actions TO anon;
GRANT ALL ON TABLE public.slack_pending_actions TO authenticated;
GRANT ALL ON TABLE public.slack_pending_actions TO service_role;


--
-- Name: TABLE sms_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.sms_logs TO anon;
GRANT ALL ON TABLE public.sms_logs TO authenticated;
GRANT ALL ON TABLE public.sms_logs TO service_role;


--
-- Name: TABLE sms_templates; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.sms_templates TO anon;
GRANT ALL ON TABLE public.sms_templates TO authenticated;
GRANT ALL ON TABLE public.sms_templates TO service_role;


--
-- Name: TABLE suggestion_comments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.suggestion_comments TO anon;
GRANT ALL ON TABLE public.suggestion_comments TO authenticated;
GRANT ALL ON TABLE public.suggestion_comments TO service_role;


--
-- Name: TABLE suggestion_posts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.suggestion_posts TO anon;
GRANT ALL ON TABLE public.suggestion_posts TO authenticated;
GRANT ALL ON TABLE public.suggestion_posts TO service_role;


--
-- Name: TABLE system_settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.system_settings TO anon;
GRANT ALL ON TABLE public.system_settings TO authenticated;
GRANT ALL ON TABLE public.system_settings TO service_role;


--
-- Name: TABLE task_assignees; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.task_assignees TO anon;
GRANT ALL ON TABLE public.task_assignees TO authenticated;
GRANT ALL ON TABLE public.task_assignees TO service_role;


--
-- Name: TABLE tasks; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.tasks TO anon;
GRANT ALL ON TABLE public.tasks TO authenticated;
GRANT ALL ON TABLE public.tasks TO service_role;


--
-- Name: TABLE weekly_meeting_comments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.weekly_meeting_comments TO anon;
GRANT ALL ON TABLE public.weekly_meeting_comments TO authenticated;
GRANT ALL ON TABLE public.weekly_meeting_comments TO service_role;


--
-- Name: TABLE weekly_meetings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.weekly_meetings TO anon;
GRANT ALL ON TABLE public.weekly_meetings TO authenticated;
GRANT ALL ON TABLE public.weekly_meetings TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- PostgreSQL database dump complete
--


