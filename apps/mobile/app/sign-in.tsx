import { Redirect, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  apiBaseWarning,
  currentApiBase,
  defaultApiBase,
  displayApiHost,
  loadSessionToken,
  normalizeApiBase,
  probeApiBase,
  resetApiBase,
  saveApiBase,
  signIn,
  signUp,
  usesCustomApiBase,
} from "../lib/api";

export default function SignIn() {
  const router = useRouter();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [apiBase, setApiBase] = useState(() => currentApiBase());
  const [serverOpen, setServerOpen] = useState(false);

  useEffect(() => {
    void loadSessionToken().then((token) => {
      setHasSession(Boolean(token));
      setReady(true);
    });
  }, []);

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: "#F7F7F4", justifyContent: "center", padding: 24 }}>
        <Text style={{ color: "#6E6E68", textAlign: "center" }}>Loading…</Text>
      </View>
    );
  }
  if (hasSession) return <Redirect href="/" />;

  async function submit() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      if (mode === "up") {
        const trimmedEmail = email.trim();
        await signUp(trimmedEmail, password, name.trim() || trimmedEmail.split("@")[0] || "User");
      } else {
        await signIn(email.trim(), password);
      }
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not continue");
    } finally {
      setPending(false);
    }
  }

  const custom = usesCustomApiBase(apiBase);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#F7F7F4" }}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
          <View style={{ flex: 1 }}>
            <ScrollView
              contentContainerStyle={{
                flexGrow: 1,
                justifyContent: "center",
                paddingHorizontal: 24,
                paddingVertical: 24,
              }}
              keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
              keyboardShouldPersistTaps="handled"
            >
              <Text
                style={{
                  color: "#1B1B1E",
                  fontSize: 32,
                  fontWeight: "500",
                  textAlign: "center",
                }}
              >
                {mode === "in" ? "Sign in to Rakazo" : "Sign up for Rakazo"}
              </Text>
              {mode === "up" ? (
                <TextInput
                  autoComplete="name"
                  placeholder="Name"
                  placeholderTextColor="#8C8C86"
                  value={name}
                  onChangeText={setName}
                  style={{
                    marginTop: 28,
                    backgroundColor: "#F1F1ED",
                    borderRadius: 13,
                    padding: 16,
                    color: "#1B1B1E",
                  }}
                />
              ) : null}
              <TextInput
                autoCapitalize="none"
                autoComplete="email"
                keyboardType="email-address"
                placeholder="Email"
                placeholderTextColor="#8C8C86"
                value={email}
                onChangeText={setEmail}
                style={{
                  marginTop: mode === "up" ? 12 : 28,
                  backgroundColor: "#F1F1ED",
                  borderRadius: 13,
                  padding: 16,
                  color: "#1B1B1E",
                }}
              />
              <TextInput
                autoComplete={mode === "in" ? "current-password" : "new-password"}
                placeholder="Password"
                placeholderTextColor="#8C8C86"
                returnKeyType="go"
                secureTextEntry
                value={password}
                onChangeText={setPassword}
                onSubmitEditing={() => void submit()}
                style={{
                  marginTop: 12,
                  backgroundColor: "#F1F1ED",
                  borderRadius: 13,
                  padding: 16,
                  color: "#1B1B1E",
                }}
              />
              {error ? <Text style={{ color: "#C94244", marginTop: 12 }}>{error}</Text> : null}
              <Pressable
                accessibilityRole="button"
                onPress={() => void submit()}
                disabled={pending}
                style={{
                  marginTop: 16,
                  backgroundColor: "#121215",
                  borderRadius: 13,
                  padding: 18,
                  alignItems: "center",
                }}
              >
                <Text style={{ color: "#FBFBF9", fontSize: 17 }}>
                  {pending ? "Working…" : mode === "in" ? "Sign in" : "Sign up"}
                </Text>
              </Pressable>
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "center",
                  alignItems: "center",
                  marginTop: 24,
                }}
              >
                <Text style={{ color: "#8C8C86", fontSize: 15 }}>
                  {mode === "in" ? "Don’t have an account?" : "Already have an account?"}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => {
                    setMode((current) => (current === "in" ? "up" : "in"));
                    setError(null);
                  }}
                  style={{ marginLeft: 5 }}
                >
                  <Text style={{ color: "#1B1B1E", fontSize: 15, fontWeight: "600" }}>
                    {mode === "in" ? "Sign up" : "Sign in"}
                  </Text>
                </Pressable>
              </View>
            </ScrollView>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                custom ? `Custom server ${displayApiHost(apiBase)}` : "Use a custom server"
              }
              hitSlop={12}
              onPress={() => setServerOpen(true)}
              style={{
                alignItems: "center",
                paddingHorizontal: 24,
                paddingBottom: 12,
                paddingTop: 8,
              }}
            >
              {custom ? (
                <>
                  <Text style={{ color: "#A8A8A2", fontSize: 12 }}>Custom server</Text>
                  <Text style={{ color: "#6E6E68", fontSize: 13, marginTop: 2 }}>
                    {displayApiHost(apiBase)}
                  </Text>
                </>
              ) : (
                <Text style={{ color: "#A8A8A2", fontSize: 13 }}>Use a custom server</Text>
              )}
            </Pressable>
          </View>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
      <ServerSheet
        visible={serverOpen}
        current={apiBase}
        onClose={() => setServerOpen(false)}
        onSaved={(url) => {
          setApiBase(url);
          setServerOpen(false);
        }}
      />
    </SafeAreaView>
  );
}

function ServerSheet({
  visible,
  current,
  onClose,
  onSaved,
}: {
  visible: boolean;
  current: string;
  onClose: () => void;
  onSaved: (url: string) => void;
}) {
  const [draft, setDraft] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setDraft(current);
    setError(null);
    setPending(false);
  }, [visible, current]);

  const parsedDraft = normalizeApiBase(draft);
  const warning = parsedDraft.ok ? apiBaseWarning(parsedDraft.url) : null;

  async function save() {
    setPending(true);
    setError(null);
    try {
      const probed = await probeApiBase(draft);
      if (!probed.ok) {
        setError(probed.error);
        return;
      }
      const saved = await saveApiBase(probed.url);
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      onSaved(saved.url);
    } finally {
      setPending(false);
    }
  }

  async function restoreDefault() {
    setPending(true);
    setError(null);
    try {
      const saved = await resetApiBase();
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      onSaved(saved.url);
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: "#F7F7F4" }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <SafeAreaView style={{ flex: 1, paddingHorizontal: 24, paddingTop: 12 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={{ color: "#6E6E68", fontSize: 17 }}>Cancel</Text>
            </Pressable>
            <Text style={{ color: "#1B1B1E", fontSize: 17, fontWeight: "600" }}>Server</Text>
            <Pressable onPress={() => void save()} disabled={pending} hitSlop={8}>
              <Text style={{ color: "#1B1B1E", fontSize: 17, fontWeight: "600" }}>
                {pending ? "Checking…" : "Save"}
              </Text>
            </Pressable>
          </View>
          <Text style={{ color: "#6E6E68", marginTop: 28, fontSize: 15, lineHeight: 22 }}>
            Point this app at your self-hosted Rakazo origin — the same HTTPS URL you open in a
            browser.
          </Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            keyboardType="url"
            textContentType="URL"
            returnKeyType="go"
            onSubmitEditing={() => void save()}
            placeholder={defaultApiBase()}
            placeholderTextColor="#8C8C86"
            value={draft}
            onChangeText={(value) => {
              setDraft(value);
              setError(null);
            }}
            style={{
              marginTop: 20,
              backgroundColor: "#F1F1ED",
              borderRadius: 13,
              padding: 16,
              color: "#1B1B1E",
              fontSize: 16,
            }}
          />
          {warning ? (
            <Text style={{ color: "#8C8C86", marginTop: 12, fontSize: 13 }}>{warning}</Text>
          ) : null}
          {error ? <Text style={{ color: "#C94244", marginTop: 12 }}>{error}</Text> : null}
          {usesCustomApiBase(current) || draft.trim() !== current ? (
            <Pressable
              onPress={() => void restoreDefault()}
              disabled={pending}
              style={{ marginTop: 28, alignItems: "center" }}
            >
              <Text style={{ color: "#6E6E68", fontSize: 15 }}>Use default server</Text>
            </Pressable>
          ) : null}
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
