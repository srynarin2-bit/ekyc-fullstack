import React from "react";
import { SafeAreaView, StatusBar, StyleSheet } from "react-native";
import { KycScreen } from "./src/screens/KycScreen";

export default function App() {
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      <KycScreen />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#f8fafc",
  },
});