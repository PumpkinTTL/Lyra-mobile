import { AppRegistry } from "react-native";
import "./src/polyfills";
import App from "./App";
import { name } from "./app.json";

AppRegistry.registerComponent(name, () => App);
