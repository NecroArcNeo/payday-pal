export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      employee_field_defs: {
        Row: {
          created_at: string
          field_type: string
          id: string
          label: string
          section: string | null
          sort_order: number
        }
        Insert: {
          created_at?: string
          field_type?: string
          id?: string
          label: string
          section?: string | null
          sort_order?: number
        }
        Update: {
          created_at?: string
          field_type?: string
          id?: string
          label?: string
          section?: string | null
          sort_order?: number
        }
        Relationships: []
      }
      employees: {
        Row: {
          active: boolean
          address_line1: string | null
          address_line2: string | null
          city: string | null
          country: string | null
          gender: string | null
          nationality: string | null
          passport_no: string | null
          residential_status: string | null
          ssn: string | null
          created_at: string
          custom_fields: Json
          date_of_birth: string | null
          department: string | null
          email: string | null
          emergency_contact_name: string | null
          emergency_contact_phone: string | null
          employee_code: string
          first_name: string
          hire_date: string | null
          hourly_rate: number
          id: string
          job_title: string | null
          last_name: string
          notes: string | null
          phone: string | null
          postal_code: string | null
          shift_id: string | null
          pay_type: string
          state: string | null
          user_id: string | null
        }
        Insert: {
          active?: boolean
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          country?: string | null
          gender?: string | null
          nationality?: string | null
          passport_no?: string | null
          residential_status?: string | null
          ssn?: string | null
          created_at?: string
          custom_fields?: Json
          date_of_birth?: string | null
          department?: string | null
          email?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          employee_code: string
          first_name: string
          hire_date?: string | null
          hourly_rate?: number
          id?: string
          job_title?: string | null
          last_name: string
          notes?: string | null
          phone?: string | null
          postal_code?: string | null
          shift_id?: string | null
          pay_type?: string
          state?: string | null
          user_id?: string | null
        }
        Update: {
          active?: boolean
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          country?: string | null
          gender?: string | null
          nationality?: string | null
          passport_no?: string | null
          residential_status?: string | null
          ssn?: string | null
          created_at?: string
          custom_fields?: Json
          date_of_birth?: string | null
          department?: string | null
          email?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          employee_code?: string
          first_name?: string
          hire_date?: string | null
          hourly_rate?: number
          id?: string
          job_title?: string | null
          last_name?: string
          notes?: string | null
          phone?: string | null
          postal_code?: string | null
          shift_id?: string | null
          pay_type?: string
          state?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      pay_adjustments: {
        Row: {
          amount: number
          category: string
          created_at: string
          employee_id: string
          id: string
          note: string | null
          pay_date: string
        }
        Insert: {
          amount?: number
          category: string
          created_at?: string
          employee_id: string
          id?: string
          note?: string | null
          pay_date: string
        }
        Update: {
          amount?: number
          category?: string
          created_at?: string
          employee_id?: string
          id?: string
          note?: string | null
          pay_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "pay_adjustments_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      pay_rates: {
        Row: {
          created_at: string
          effective_from: string
          employee_id: string
          hourly_rate: number
          id: string
        }
        Insert: {
          created_at?: string
          effective_from: string
          employee_id: string
          hourly_rate: number
          id?: string
        }
        Update: {
          created_at?: string
          effective_from?: string
          employee_id?: string
          hourly_rate?: number
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pay_rates_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      payroll_settings: {
        Row: {
          employee_defaults: Json
          locked_through: string | null
          id: boolean
          ot_multiplier: number
          ot_threshold: number
          weekend_overtime: boolean
          updated_at: string
          visible_columns: string[]
        }
        Insert: {
          employee_defaults?: Json
          locked_through?: string | null
          id?: boolean
          ot_multiplier?: number
          ot_threshold?: number
          weekend_overtime?: boolean
          updated_at?: string
          visible_columns?: string[]
        }
        Update: {
          employee_defaults?: Json
          locked_through?: string | null
          id?: boolean
          ot_multiplier?: number
          ot_threshold?: number
          weekend_overtime?: boolean
          updated_at?: string
          visible_columns?: string[]
        }
        Relationships: []
      }
      time_records: {
        Row: {
          clock_in: string | null
          clock_out: string | null
          created_at: string
          employee_id: string
          entry_mode: string
          hours: number
          id: string
          lunch_minutes: number
          pay_override: number | null
          shift_id: string | null
          unlocked: boolean
          note: string | null
          work_date: string
        }
        Insert: {
          clock_in?: string | null
          clock_out?: string | null
          created_at?: string
          employee_id: string
          entry_mode?: string
          hours?: number
          id?: string
          lunch_minutes?: number
          pay_override?: number | null
          shift_id?: string | null
          unlocked?: boolean
          note?: string | null
          work_date: string
        }
        Update: {
          clock_in?: string | null
          clock_out?: string | null
          created_at?: string
          employee_id?: string
          entry_mode?: string
          hours?: number
          id?: string
          lunch_minutes?: number
          pay_override?: number | null
          shift_id?: string | null
          unlocked?: boolean
          note?: string | null
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "time_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      shifts: {
        Row: {
          created_at: string
          default_clock_in: string | null
          default_clock_out: string | null
          default_lunch_minutes: number | null
          id: string
          multiplier: number
          name: string
          sort_order: number
        }
        Insert: {
          created_at?: string
          default_clock_in?: string | null
          default_clock_out?: string | null
          default_lunch_minutes?: number | null
          id?: string
          multiplier?: number
          name: string
          sort_order?: number
        }
        Update: {
          created_at?: string
          default_clock_in?: string | null
          default_clock_out?: string | null
          default_lunch_minutes?: number | null
          id?: string
          multiplier?: number
          name?: string
          sort_order?: number
        }
        Relationships: []
      }
      cloud_backups: {
        Row: {
          created_at: string
          id: number
          owner_id: string
          reason: string
          snapshot: Json
          version: number
        }
        Insert: never
        Update: never
        Relationships: []
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      pull_snapshot: { Args: never; Returns: Json }
      push_snapshot: {
        Args: { p_expected_version: number; p_snapshot: Json }
        Returns: number
      }
      sync_status: { Args: never; Returns: Json }
    }
    Enums: {
      app_role: "admin" | "employee"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "employee"],
    },
  },
} as const
